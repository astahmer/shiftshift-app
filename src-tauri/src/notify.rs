//! Optional "something was saved" notification. Off by default —
//! `Settings::notification_style` picks between the OS notification center
//! (native), a small dedicated toast window (custom — see `toast.rs`), or
//! nothing.
//!
//! On macOS, native notifications shell out to `osascript -e 'display
//! notification ...'` rather than going through `tauri-plugin-notification`.
//! That plugin's `Notification::show()` (see its `desktop.rs`) spawns the
//! actual `notify_rust::Notification::show()` call onto `tauri::
//! async_runtime::spawn` and discards the result *inside* that closure,
//! then returns `Ok(())` unconditionally from the outer function — so
//! checking its `Result` can never actually surface a failure. `display
//! notification` is also a simpler, non-deprecated AppleScript command that
//! doesn't need the app registered with Notification Center the way
//! `NSUserNotification`/`UNUserNotification` do.
//!
//! The sound is played separately from the notification itself, via
//! `afplay -v <volume>` against a file under `/System/Library/Sounds` —
//! `display notification`'s own `sound name` clause has no volume control,
//! and (unrelated bug fixed in passing) only accepts real macOS sound
//! names ("Glass", "Ping", ...), not the literal string "default" this
//! used to pass.

use tauri::{AppHandle, Manager};

use crate::settings::{NotificationStyle, NotifyContent, SettingsState};
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

/// Title/body for the custom toast window. `IconOnly` is genuinely empty —
/// native banners can't do that, so `notify_captured` keeps a kind-label
/// fallback only for `NotificationStyle::Native`.
pub fn custom_toast_copy(content: NotifyContent, title: &str, excerpt: &str) -> (String, String) {
    match content {
        NotifyContent::IconOnly => (String::new(), String::new()),
        NotifyContent::IconTitle => (title.to_string(), String::new()),
        NotifyContent::IconTitleExcerpt => (title.to_string(), excerpt.to_string()),
        NotifyContent::IconExcerpt => (String::new(), excerpt.to_string()),
    }
}

pub fn notify_captured(app: &AppHandle, item: &Item) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    if settings.notification_style == NotificationStyle::None {
        return;
    }
    let kind_label = match item.kind {
        crate::store::ItemKind::Todo => "Todo saved",
        crate::store::ItemKind::Link => "Link saved",
        crate::store::ItemKind::Note => "Note saved",
        crate::store::ItemKind::Image => "Image saved",
    };
    let excerpt_text = excerpt(&item.text);
    // Custom toasts can be genuinely icon-only (empty title + body). Native
    // can't (`display notification` requires a body), so `IconOnly` there
    // still falls back to the kind label — see `NotifyContent`'s doc comment.
    let (title, body) = if settings.notification_style == NotificationStyle::Custom {
        custom_toast_copy(settings.notify_content, kind_label, &excerpt_text)
    } else {
        match settings.notify_content {
            NotifyContent::IconOnly => (String::new(), kind_label.to_string()),
            NotifyContent::IconTitle => (kind_label.to_string(), String::new()),
            NotifyContent::IconTitleExcerpt => (kind_label.to_string(), excerpt_text),
            NotifyContent::IconExcerpt => (String::new(), excerpt_text),
        }
    };

    if settings.notify_sound {
        play_sound(&settings.notify_sound_name, settings.notify_sound_volume);
    }

    match settings.notification_style {
        NotificationStyle::None => {}
        NotificationStyle::Native => {
            if let Err(e) = show_native_notification(&title, &body) {
                eprintln!("shiftshift: notification failed to show: {e}");
            }
        }
        NotificationStyle::Custom => {
            crate::toast::show_capture_toast(app, &title, &body);
        }
    }
}

/// Settings -> Notifications -> "Test notification" — same path as a real
/// save, so the user sees the current style/content/position/sound.
pub fn preview_sample(app: &AppHandle) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    let excerpt_text = "This is a test notification";
    let (title, body) = if settings.notification_style == NotificationStyle::Custom {
        custom_toast_copy(settings.notify_content, "Note saved", excerpt_text)
    } else {
        ("Note saved".to_string(), excerpt_text.to_string())
    };
    if settings.notify_sound {
        play_sound(&settings.notify_sound_name, settings.notify_sound_volume);
    }
    match settings.notification_style {
        NotificationStyle::None | NotificationStyle::Custom => {
            crate::toast::show_capture_toast(app, &title, &body);
        }
        NotificationStyle::Native => {
            if let Err(e) = show_native_notification(&title, &body) {
                eprintln!("shiftshift: notification failed to show: {e}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn show_native_notification(title: &str, body: &str) -> Result<(), String> {
    let script = build_applescript(title, body);
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn build_applescript(title: &str, body: &str) -> String {
    format!(
        "display notification {} with title {}",
        applescript_string(body),
        applescript_string(title)
    )
}

/// Quotes a string for interpolation into an AppleScript string literal —
/// escapes backslashes and double quotes, the two characters that would
/// otherwise break out of the `"..."` the notification title/body sits in.
#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Fire-and-forget — a missing/unrecognized sound name is skipped, not an
/// error, since the sound is a secondary effect and shouldn't block the
/// notification/toast itself over it.
#[cfg(target_os = "macos")]
pub fn play_sound(name: &str, volume: u8) {
    let path = std::path::PathBuf::from("/System/Library/Sounds").join(format!("{name}.aiff"));
    if !path.exists() {
        return;
    }
    let volume_arg = format!("{:.2}", f32::from(volume.min(100)) / 100.0);
    let _ = std::process::Command::new("afplay")
        .arg("-v")
        .arg(volume_arg)
        .arg(path)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
fn show_native_notification(_title: &str, _body: &str) -> Result<(), String> {
    // Native notifications are macOS-only for now, like most of the rest of
    // this app's OS-integration code (mac_tap.rs, vibrancy.rs, ...) — the
    // "custom" in-app toast style still works on every platform, since it's
    // just the panel window.
    Err("native notifications aren't wired up on this platform yet".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn play_sound(_name: &str, _volume: u8) {}

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

    #[test]
    fn custom_icon_only_is_genuinely_empty() {
        assert_eq!(
            custom_toast_copy(NotifyContent::IconOnly, "Note saved", "buy milk"),
            (String::new(), String::new())
        );
    }

    #[test]
    fn custom_icon_title_omits_the_excerpt() {
        assert_eq!(
            custom_toast_copy(NotifyContent::IconTitle, "Note saved", "buy milk"),
            ("Note saved".into(), String::new())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_string_escapes_quotes_and_backslashes() {
        assert_eq!(
            applescript_string(r#"say "hi" \ ok"#),
            r#""say \"hi\" \\ ok""#
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_applescript_quotes_title_and_body() {
        let script = build_applescript("My Title", "My body");
        assert_eq!(
            script,
            r#"display notification "My body" with title "My Title""#
        );
    }
}
