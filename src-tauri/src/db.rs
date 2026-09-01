use std::sync::Arc;

use crate::settings::Settings;
use crate::store::{FolderStore, LocalSqliteStore, S3Store, Store};

/// App-state wrapper around the active backend — reads the choice from
/// `Settings::backend` (shiftshift's "pick a backend" model) and constructs
/// the matching `Arc<dyn Store>`; call sites never know which one is live.
/// Switching backends takes effect on next launch, not live — `settings.rs`
/// documents that on the field itself.
///
/// Also tracks what's *actually* in use versus what Settings asked for —
/// `active_backend`/`fallback_reason` exist because a misconfigured S3/
/// folder backend used to fail completely silently (an `eprintln!` to a
/// terminal nobody's watching, with the UI just quietly using local storage
/// forever with no explanation). `commands::get_sync_status` exposes both
/// to the frontend so Settings can show a real status instead.
pub struct Db {
    pub store: Arc<dyn Store>,
    pub active_backend: String,
    pub fallback_reason: Option<String>,
}

impl Db {
    /// Never fails just because a remote/folder backend is misconfigured: an
    /// incomplete or wrong config would otherwise `.expect()`-panic the whole
    /// app on startup with no window ever shown to get back into Settings
    /// and fix it — so this falls back to local storage instead, loudly, on
    /// stderr (and now, via `active_backend`/`fallback_reason`, in the UI).
    pub fn open(app_data_dir: &std::path::Path, settings: &Settings) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        if settings.backend == "s3" {
            match S3Store::open(&settings.s3) {
                Ok(store) => {
                    return Ok(Self {
                        store: Arc::new(store),
                        active_backend: "s3".to_string(),
                        fallback_reason: None,
                    })
                }
                Err(e) => {
                    eprintln!(
                        "shiftshift: S3 backend unavailable ({e}), falling back to local storage"
                    );
                    return Self::open_local_fallback(
                        app_data_dir,
                        settings,
                        format!("S3 backend unavailable: {e}"),
                    );
                }
            }
        }
        if settings.backend == "folder" {
            match FolderStore::open(&settings.folder_path) {
                Ok(store) => {
                    return Ok(Self {
                        store: Arc::new(store),
                        active_backend: "folder".to_string(),
                        fallback_reason: None,
                    })
                }
                Err(e) => {
                    eprintln!("shiftshift: folder backend unavailable ({e}), falling back to local storage");
                    return Self::open_local_fallback(
                        app_data_dir,
                        settings,
                        format!("Folder backend unavailable: {e}"),
                    );
                }
            }
        }
        let store = Self::open_local(app_data_dir, settings)?;
        Ok(Self {
            store: Arc::new(store),
            active_backend: "local".to_string(),
            fallback_reason: None,
        })
    }

    fn open_local_fallback(
        app_data_dir: &std::path::Path,
        settings: &Settings,
        reason: String,
    ) -> Result<Self, String> {
        let store = Self::open_local(app_data_dir, settings)?;
        Ok(Self {
            store: Arc::new(store),
            active_backend: "local".to_string(),
            fallback_reason: Some(reason),
        })
    }

    fn open_local(
        app_data_dir: &std::path::Path,
        settings: &Settings,
    ) -> Result<LocalSqliteStore, String> {
        let db_path = app_data_dir.join("shiftshift.sqlite3");
        if settings.encrypt_local_storage {
            let key = crate::db_encryption::get_or_create_key()?;
            LocalSqliteStore::open_with_key(&db_path, Some(&key))
        } else {
            LocalSqliteStore::open(&db_path)
        }
    }
}
