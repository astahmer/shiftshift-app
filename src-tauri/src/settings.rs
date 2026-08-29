//! Persisted user settings — today just the double-shift `Bindings`. Kept as
//! its own small JSON file rather than a table in the SQLite store so it can
//! be read once at startup before the DB (and the rest of app state) exists.

use std::path::Path;
use std::sync::Mutex;

use crate::capture::Bindings;

const FILE_NAME: &str = "settings.json";

/// Shared, live-readable bindings. The tap listeners re-read this on every
/// gesture rather than capturing a snapshot, so a change from the settings
/// screen applies immediately without restarting the listener thread.
pub struct SettingsState(pub Mutex<Bindings>);

pub fn load(app_data_dir: &Path) -> Bindings {
    std::fs::read_to_string(app_data_dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app_data_dir: &Path, bindings: Bindings) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&bindings).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(FILE_NAME), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Action;

    #[test]
    fn missing_file_falls_back_to_default_bindings() {
        let dir = tempdir();
        let bindings = load(&dir);
        assert_eq!(bindings.left, Action::Capture);
        assert_eq!(bindings.right, Action::TogglePanel);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let bindings = Bindings { left: Action::None, right: Action::Capture };
        save(&dir, bindings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.left, Action::None);
        assert_eq!(loaded.right, Action::Capture);
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shiftshift-settings-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
