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

fn default_alpha_100() -> u8 {
    100
}

fn default_radius() -> u8 {
    16
}

fn default_radius_sm() -> u8 {
    10
}

fn default_font_size() -> u8 {
    14
}

fn default_font_weight() -> u16 {
    500
}

fn default_border_width() -> u8 {
    1
}

fn default_gap() -> u8 {
    10
}

fn default_pad() -> u8 {
    12
}

/// Palette a custom theme can set. The original 7 color roles stay required
/// so older `custom_themes.json` files still load; everything after that is
/// optional (`""` / default alpha) and the frontend falls back to the core
/// roles when a component-specific color isn't set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub row_bg: String,
    pub accent: String,
    pub accent_fg: String,
    pub border: String,
    #[serde(default = "default_alpha_100")]
    pub bg_alpha: u8,
    #[serde(default = "default_alpha_100")]
    pub row_alpha: u8,
    #[serde(default)]
    pub input_bg: String,
    #[serde(default)]
    pub input_fg: String,
    #[serde(default)]
    pub input_border: String,
    #[serde(default)]
    pub button_bg: String,
    #[serde(default)]
    pub button_fg: String,
    #[serde(default)]
    pub selected_bg: String,
    #[serde(default)]
    pub hover_bg: String,
    #[serde(default)]
    pub danger: String,
    #[serde(default)]
    pub meta: String,
    #[serde(default = "default_radius")]
    pub radius: u8,
    #[serde(default = "default_radius")]
    pub window_radius: u8,
    #[serde(default = "default_radius_sm")]
    pub radius_sm: u8,
    #[serde(default)]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_font_weight")]
    pub font_weight: u16,
    #[serde(default = "default_border_width")]
    pub border_width: u8,
    #[serde(default)]
    pub backdrop_blur: u8,
    #[serde(default)]
    pub press_offset: u8,
    #[serde(default = "default_gap")]
    pub gap: u8,
    #[serde(default = "default_pad")]
    pub pad: u8,
}

impl Default for ThemeColors {
    fn default() -> Self {
        Self {
            bg: String::new(),
            fg: String::new(),
            muted: String::new(),
            row_bg: String::new(),
            accent: String::new(),
            accent_fg: String::new(),
            border: String::new(),
            bg_alpha: 100,
            row_alpha: 100,
            input_bg: String::new(),
            input_fg: String::new(),
            input_border: String::new(),
            button_bg: String::new(),
            button_fg: String::new(),
            selected_bg: String::new(),
            hover_bg: String::new(),
            danger: String::new(),
            meta: String::new(),
            radius: 16,
            window_radius: 16,
            radius_sm: 10,
            font_family: String::new(),
            font_size: 14,
            font_weight: 500,
            border_width: 1,
            backdrop_blur: 0,
            press_offset: 0,
            gap: 10,
            pad: 12,
        }
    }
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
        let dir = std::env::temp_dir().join(format!(
            "shiftshift-custom-themes-test-{}",
            uuid::Uuid::new_v4()
        ));
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
            ..ThemeColors::default()
        }
    }

    #[test]
    fn missing_file_yields_no_themes() {
        assert!(load(&tempdir()).is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let themes = vec![CustomTheme {
            id: "1".into(),
            name: "Midnight".into(),
            mode: "dark".into(),
            colors: colors(),
        }];
        save(&dir, &themes).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Midnight");
        assert_eq!(loaded[0].colors.accent, "#5af");
        assert_eq!(loaded[0].colors.bg_alpha, 100);
        assert_eq!(loaded[0].colors.input_bg, "");
        assert_eq!(loaded[0].colors.gap, 10);
        assert_eq!(loaded[0].colors.pad, 12);
    }

    #[test]
    fn older_seven_role_palette_gets_spacing_defaults() {
        let raw = r##"[{"id":"1","name":"Old","mode":"dark","colors":{"bg":"#111","fg":"#eee","muted":"#888","row_bg":"#222","accent":"#5af","accent_fg":"#000","border":"#333"}}]"##;
        let themes: Vec<CustomTheme> = serde_json::from_str(raw).unwrap();
        assert_eq!(themes[0].colors.gap, 10);
        assert_eq!(themes[0].colors.pad, 12);
        assert_eq!(themes[0].colors.radius, 16);
    }
}
