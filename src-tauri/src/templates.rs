//! Snippet templates, invoked from the capture input as `/name arg1 arg2`
//! (see `expandTemplate` in `src/main.ts` — expansion happens client-side,
//! this module only persists the `name`/`body` pairs). Stored as a flat JSON
//! file like `settings.rs`; a handful of user-authored snippets doesn't
//! warrant a SQLite table.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "templates.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub body: String,
}

pub struct TemplatesState(pub Mutex<Vec<Template>>);

pub fn load(app_data_dir: &Path) -> Vec<Template> {
    std::fs::read_to_string(app_data_dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app_data_dir: &Path, templates: &[Template]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(templates).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(FILE_NAME), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shiftshift-templates-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_yields_no_templates() {
        assert!(load(&tempdir()).is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir();
        let templates = vec![Template { id: "1".into(), name: "standup".into(), body: "did: {{a}}".into() }];
        save(&dir, &templates).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "standup");
        assert_eq!(loaded[0].body, "did: {{a}}");
    }
}
