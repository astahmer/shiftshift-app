use std::sync::Arc;

use crate::store::{LocalSqliteStore, Store};

/// App-state wrapper around the active backend. Backend selection lives here
/// (shiftshift's "pick a backend" model) rather than behind a runtime
/// registry: today only `LocalSqliteStore` exists, so there is nothing to
/// pick between yet. When a remote backend (atproto/S3-style, see
/// shiftshift's prior art) ships, `open()` reads the choice from settings and
/// constructs the matching `Arc<dyn Store>` — call sites never change.
pub struct Db(pub Arc<dyn Store>);

impl Db {
    pub fn open(app_data_dir: &std::path::Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        let db_path = app_data_dir.join("shiftshift.sqlite3");
        let store = LocalSqliteStore::open(&db_path)?;
        Ok(Self(Arc::new(store)))
    }
}
