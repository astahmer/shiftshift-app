//! Persisted user settings (double-shift bindings, theme, notifications,
//! fallback global-shortcut accelerators). Kept as its own small JSON file
//! rather than a table in the SQLite store so it can be read once at startup
//! before the DB (and the rest of app state) exists.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::capture::Bindings;

const FILE_NAME: &str = "settings.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub bindings: Bindings,
    /// Opaque to Rust — the frontend owns the theme registry and CSS variable
    /// blocks (see `src/themes.ts`); this is just persisted verbatim.
    pub theme: String,
    pub notify_on_save: bool,
    pub notify_sound: bool,
    /// Tauri accelerator strings (e.g. "CmdOrCtrl+Shift+Space") for the
    /// fallback global shortcuts, used where the raw double-shift hook is
    /// unavailable or denied.
    pub fallback_toggle: String,
    pub fallback_capture: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            bindings: Bindings::default(),
            theme: "tokyo-night".to_string(),
            notify_on_save: false,
            notify_sound: true,
            fallback_toggle: "CmdOrCtrl+Shift+Space".to_string(),
            fallback_capture: "CmdOrCtrl+Shift+C".to_string(),
        }
    }
}

/// Shared, live-readable settings. The tap listeners and shortcut handlers
/// re-read this on every gesture rather than capturing a snapshot, so a
/// change from the settings screen applies immediately, no restart needed.
pub struct SettingsState(pub Mutex<Settings>);

pub fn load(app_data_dir: &Path) -> Settings {
    let Some(raw) = std::fs::read_to_string(app_data_dir.join(FILE_NAME)).ok() else {
        return Settings::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Settings::default();
    };
    // `#[serde(default)]` would happily (mis)parse a legacy bindings-only
    // file as a Settings with default everything-else and the top-level
    // left/right keys silently ignored as unknown fields — so the shape is
    // checked explicitly rather than just trying Settings first.
    if value.get("bindings").is_some() {
        return serde_json::from_value(value).unwrap_or_default();
    }
    // Legacy settings.json from before Settings grew beyond just bindings —
    // the whole file used to *be* a bare Bindings object.
    if let Ok(bindings) = serde_json::from_value::<Bindings>(value) {
        return Settings { bindings, ..Settings::default() };
    }
    Settings::default()
}

pub fn save(app_data_dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(FILE_NAME), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Action;

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let settings = load(&tempdir());
        assert_eq!(settings.bindings.left, Action::Capture);
        assert_eq!(settings.theme, "tokyo-night");
        assert!(!settings.notify_on_save);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let mut settings = Settings::default();
        settings.bindings = Bindings { left: Action::None, right: Action::Capture };
        settings.theme = "dracula".to_string();
        settings.notify_on_save = true;
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.bindings.left, Action::None);
        assert_eq!(loaded.theme, "dracula");
        assert!(loaded.notify_on_save);
    }

    #[test]
    fn reads_a_legacy_bindings_only_settings_file() {
        let dir = tempdir();
        std::fs::write(dir.join(FILE_NAME), r#"{"left":"none","right":"capture"}"#).unwrap();
        let settings = load(&dir);
        assert_eq!(settings.bindings.left, Action::None);
        assert_eq!(settings.bindings.right, Action::Capture);
        assert_eq!(settings.theme, "tokyo-night");
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shiftshift-settings-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
