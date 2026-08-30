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
        let excluded = app.state::<SettingsState>().0.lock().unwrap().excluded_apps.clone();
        if is_excluded_app(&source, &excluded) {
            continue;
        }
        let _ = crate::capture::handle_captured_text(&app, trimmed, Some(source));
    });
}

/// Case-insensitive substring match, in both directions of length — a
/// captured frontmost-app name like "1Password 7" should match a settings
/// entry of "1Password", and a full-name entry should still match a
/// shorter frontmost name if the OS reports one that way.
fn is_excluded_app(source_app: &str, excluded: &[String]) -> bool {
    let lower = source_app.to_lowercase();
    excluded.iter().any(|entry| {
        let entry_lower = entry.trim().to_lowercase();
        !entry_lower.is_empty() && (lower.contains(&entry_lower) || entry_lower.contains(&lower))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_frontmost_name_that_contains_the_excluded_entry() {
        let excluded = vec!["1Password".to_string()];
        assert!(is_excluded_app("1Password 7", &excluded));
    }

    #[test]
    fn matches_case_insensitively() {
        let excluded = vec!["bitwarden".to_string()];
        assert!(is_excluded_app("Bitwarden", &excluded));
    }

    #[test]
    fn does_not_match_an_unrelated_app() {
        let excluded = vec!["1Password".to_string()];
        assert!(!is_excluded_app("Safari", &excluded));
    }

    #[test]
    fn ignores_blank_entries() {
        let excluded = vec!["".to_string(), "   ".to_string()];
        assert!(!is_excluded_app("Safari", &excluded));
    }
}
