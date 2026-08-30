//! Optional, opt-in "something was saved" notification. Off by default —
//! see `Settings::notify_on_save`/`notify_sound`.
//!
//! On macOS this shells out to `osascript -e 'display notification ...'`
//! rather than going through `tauri-plugin-notification`. That plugin's
//! `Notification::show()` (see its `desktop.rs`) spawns the actual
//! `notify_rust::Notification::show()` call onto `tauri::async_runtime::
//! spawn` and discards the result *inside* that closure, then returns
//! `Ok(())` unconditionally from the outer function — so checking its
//! `Result` can never actually surface a failure; that's why an earlier
//! error-check here never printed anything even when nothing appeared.
//! `display notification` is also a fundamentally simpler, non-deprecated
//! AppleScript command that doesn't need the app to be registered with
//! Notification Center the way `NSUserNotification`/`UNUserNotification`
//! do, which is what makes the plugin need its `com.apple.Terminal`
//! dev-mode identity workaround in the first place.

use tauri::{AppHandle, Manager};

use crate::settings::SettingsState;
use crate::store::Item;

const EXCERPT_MAX: usize = 60;

/// Collapses an item's text to a single line and truncates it for a
/// notification body — a multi-line capture would otherwise blow out the
/// notification's height, and OS notification centers don't wrap forever.
fn excerpt(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_MAX {
        return flat;
    }
    let truncated: String = flat.chars().take(EXCERPT_MAX).collect();
    format!("{}…", truncated.trim_end())
}

pub fn notify_captured(app: &AppHandle, item: &Item) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    if !settings.notify_on_save {
        return;
    }
    let title = match item.kind {
        crate::store::ItemKind::Todo => "Todo saved",
        crate::store::ItemKind::Link => "Link saved",
        crate::store::ItemKind::Note => "Note saved",
        crate::store::ItemKind::Image => "Image saved",
    };
    let body = excerpt(&item.text);
    if let Err(e) = show_notification(app, title, &body, settings.notify_sound) {
        eprintln!("shiftshift: notification failed to show: {e}");
    }
}

#[cfg(target_os = "macos")]
fn show_notification(_app: &AppHandle, title: &str, body: &str, sound: bool) -> Result<(), String> {
    let script = build_applescript(title, body, sound);
    let output = std::process::Command::new("osascript").arg("-e").arg(&script).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// A valid macOS system sound name (Glass/Ping/Sosumi/...) — "default" (the
/// previous value, passed straight through to `notify-rust`) isn't one of
/// these, so the plugin's own sound support was silently a no-op even on
/// the rare occasion its notification did display.
#[cfg(target_os = "macos")]
fn build_applescript(title: &str, body: &str, sound: bool) -> String {
    let mut script = format!("display notification {} with title {}", applescript_string(body), applescript_string(title));
    if sound {
        script.push_str(" sound name \"Glass\"");
    }
    script
}

/// Quotes a string for interpolation into an AppleScript string literal —
/// escapes backslashes and double quotes, the two characters that would
/// otherwise break out of the `"..."` the notification title/body sits in.
#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(not(target_os = "macos"))]
fn show_notification(app: &AppHandle, title: &str, body: &str, sound: bool) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title).body(body);
    if sound {
        builder = builder.sound("default");
    }
    builder.show().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_passes_short_single_line_text_through_unchanged() {
        assert_eq!(excerpt("buy milk"), "buy milk");
    }

    #[test]
    fn excerpt_collapses_newlines_and_extra_whitespace() {
        assert_eq!(excerpt("line one\n\n  line   two"), "line one line two");
    }

    #[test]
    fn excerpt_truncates_long_text_with_an_ellipsis() {
        let long = "word ".repeat(30);
        let result = excerpt(&long);
        assert!(result.ends_with('…'));
        assert!(result.chars().count() <= EXCERPT_MAX + 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_string_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_string(r#"say "hi" \ ok"#), r#""say \"hi\" \\ ok""#);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_applescript_includes_sound_only_when_requested() {
        let with_sound = build_applescript("Title", "Body", true);
        assert!(with_sound.contains("sound name \"Glass\""));
        let without_sound = build_applescript("Title", "Body", false);
        assert!(!without_sound.contains("sound name"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_applescript_quotes_title_and_body() {
        let script = build_applescript("My Title", "My body", false);
        assert_eq!(script, r#"display notification "My body" with title "My Title""#);
    }
}
