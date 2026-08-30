//! User-defined themes — a name plus the same 7 CSS custom-property values
//! the built-in themes hard-code in `src/style.css` (`src/themes.ts` owns the
//! built-in registry; this is the parallel user-authored one, applied by the
//! frontend as inline styles rather than a `[data-theme]` CSS block). Stored
//! as a flat JSON file like `templates.rs` — a handful of hand-picked
//! palettes doesn't warrant a SQLite table. Colors are opaque CSS color
//! strings (hex, rgb(), etc) to Rust; only the frontend interprets them.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "custom_themes.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub row_bg: String,
    pub accent: String,
    pub accent_fg: String,
    pub border: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    /// "light" or "dark" — mirrors `ThemeMode` in `themes.ts`, used for
    /// `/light`/`/dark` filtering and the `color-scheme` CSS property.
    pub mode: String,
    pub colors: ThemeColors,
}

pub struct CustomThemesState(pub Mutex<Vec<CustomTheme>>);

pub fn load(app_data_dir: &Path) -> Vec<CustomTheme> {
    std::fs::read_to_string(app_data_dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app_data_dir: &Path, themes: &[CustomTheme]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(themes).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(FILE_NAME), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shiftshift-custom-themes-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn colors() -> ThemeColors {
        ThemeColors {
            bg: "#111".into(),
            fg: "#eee".into(),
            muted: "#888".into(),
            row_bg: "#222".into(),
            accent: "#5af".into(),
            accent_fg: "#000".into(),
            border: "#333".into(),
        }
    }

    #[test]
    fn missing_file_yields_no_themes() {
        assert!(load(&tempdir()).is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let themes = vec![CustomTheme { id: "1".into(), name: "Midnight".into(), mode: "dark".into(), colors: colors() }];
        save(&dir, &themes).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Midnight");
        assert_eq!(loaded[0].colors.accent, "#5af");
    }
}
