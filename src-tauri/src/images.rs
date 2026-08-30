//! Save-image support: a dedicated global shortcut (`fallback_image` in
//! Settings, alongside the toggle/capture ones) grabs whatever image is
//! currently on the system clipboard and stores it as a PNG file under the
//! app data dir. `Item::text` holds that file's absolute path for
//! `ItemKind::Image` items — the frontend renders it via Tauri's asset
//! protocol (`convertFileSrc`) rather than through any IPC round-trip of
//! the image bytes themselves.
//!
//! Chose a dedicated shortcut over folding this into the existing
//! double-shift capture gesture: that gesture simulates a *text* copy
//! chord, which would clobber whatever image is already on the clipboard
//! before we could read it.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use crate::store::ItemKind;

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_png(image: &arboard::ImageData, path: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), image.width as u32, image.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&image.bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies a saved image item back to the system clipboard — the inverse of
/// `capture_clipboard_image`, so clicking a thumbnail is useful the way
/// cooper's is ("click a thumbnail to copy the image back to your clipboard").
pub fn copy_image_to_clipboard(path: &str) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or("could not determine the PNG's buffer size")?];
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

/// Saves the clipboard's current image as a new item. Errors (surfaced to
/// the caller, e.g. a settings-screen toast) if the clipboard has no image.
pub fn capture_clipboard_image(app: &AppHandle) -> Result<(), String> {
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = clip.get_image().map_err(|_| "the clipboard has no image right now".to_string())?;
    let path = images_dir(app)?.join(format!("{}.png", uuid::Uuid::new_v4()));
    write_png(&image, &path)?;

    let db = app.state::<crate::db::Db>();
    let item = db.0.add_item(&path.to_string_lossy(), ItemKind::Image, None)?;
    let _ = db.0.log_event(Some(&item.id), "created", Some("image"));
    let _ = app.emit("refresh", ());
    crate::notify::notify_captured(app, &item);
    Ok(())
}
