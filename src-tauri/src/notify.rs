//! Optional, opt-in "something was saved" notification. Off by default —
//! see `Settings::notify_on_save`/`notify_sound`.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

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
    let mut builder = app.notification().builder().title(title).body(excerpt(&item.text));
    if settings.notify_sound {
        builder = builder.sound("default");
    }
    let _ = builder.show();
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
}
