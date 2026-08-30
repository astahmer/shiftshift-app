//! Optional auto-capture of everything copied to the system clipboard
//! (shiftshift's clipboard-watch), own writes excluded. Off by default.
//!
//! "Own writes" covers two sources: `capture::handle_captured_text` seeds
//! `LAST_KNOWN_CLIPBOARD` with whatever it just saved (see `note_own_write`),
//! and the frontend calls the `note_own_clipboard_write` command after any
//! copy-out action (Enter on a row, the multi-select numbered-list join) —
//! those happen via the browser's Clipboard API, invisible to this Rust-side
//! poller otherwise.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::settings::SettingsState;

static LAST_KNOWN_CLIPBOARD: Mutex<Option<String>> = Mutex::new(None);

const POLL_INTERVAL: Duration = Duration::from_millis(800);

pub fn note_own_write(text: &str) {
    *LAST_KNOWN_CLIPBOARD.lock().unwrap() = Some(text.to_string());
}

/// Starts the poller. Seeds the "last known" value from whatever is on the
/// clipboard right now, so turning the setting on doesn't immediately
/// re-capture something that was already there.
pub fn start(app: AppHandle) {
    if let Ok(mut clip) = arboard::Clipboard::new() {
        if let Ok(text) = clip.get_text() {
            note_own_write(&text);
        }
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let enabled = app.state::<SettingsState>().0.lock().unwrap().clipboard_watch;
        if !enabled {
            continue;
        }
        let Ok(mut clip) = arboard::Clipboard::new() else { continue };
        let Ok(text) = clip.get_text() else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut last = LAST_KNOWN_CLIPBOARD.lock().unwrap();
        if last.as_deref() == Some(text.as_str()) {
            continue;
        }
        *last = Some(text.clone());
        drop(last);
        let source = crate::capture::frontmost_app_name().unwrap_or_else(|| "Clipboard".to_string());
        let _ = crate::capture::handle_captured_text(&app, trimmed, Some(source));
    });
}
