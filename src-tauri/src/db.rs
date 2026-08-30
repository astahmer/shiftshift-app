use std::sync::Arc;

use crate::settings::Settings;
use crate::store::{FolderStore, LocalSqliteStore, S3Store, Store};

/// App-state wrapper around the active backend — reads the choice from
/// `Settings::backend` (shiftshift's "pick a backend" model) and constructs
/// the matching `Arc<dyn Store>`; call sites never know which one is live.
/// Switching backends takes effect on next launch, not live — `settings.rs`
/// documents that on the field itself.
pub struct Db(pub Arc<dyn Store>);

impl Db {
    /// Never fails just because a remote/folder backend is misconfigured: an
    /// incomplete or wrong config would otherwise `.expect()`-panic the whole
    /// app on startup with no window ever shown to get back into Settings
    /// and fix it — so this falls back to local storage instead, loudly, on
    /// stderr.
    pub fn open(app_data_dir: &std::path::Path, settings: &Settings) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        if settings.backend == "s3" {
            match S3Store::open(&settings.s3) {
                Ok(store) => return Ok(Self(Arc::new(store))),
                Err(e) => eprintln!("shiftshift: S3 backend unavailable ({e}), falling back to local storage"),
            }
        }
        if settings.backend == "folder" {
            match FolderStore::open(&settings.folder_path) {
                Ok(store) => return Ok(Self(Arc::new(store))),
                Err(e) => eprintln!("shiftshift: folder backend unavailable ({e}), falling back to local storage"),
            }
        }
        let db_path = app_data_dir.join("shiftshift.sqlite3");
        let store = if settings.encrypt_local_storage {
            let key = crate::db_encryption::get_or_create_key()?;
            LocalSqliteStore::open_with_key(&db_path, Some(&key))?
        } else {
            LocalSqliteStore::open(&db_path)?
        };
        Ok(Self(Arc::new(store)))
    }
}
