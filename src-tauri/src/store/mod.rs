//! Storage port. Everything above this module only knows `Item` and `Store` —
//! it never touches SQLite, a remote API, or a file format directly. This
//! mirrors shiftshift's ports-and-adapters split (see its `store/types.ts`),
//! deliberately kept as "pick one backend, run it exclusively" rather than a
//! CRDT-merged multi-writer store.
//!
//! CONFLICT RESOLUTION (future work, once a remote backend ships):
//! A single device writing to a single backend has no conflicts. The moment
//! two devices sync through the same remote backend (e.g. two Macs pointed at
//! one S3 bucket), last-write-wins on `updated_at` is NOT safe for todos: a
//! toggle on device A and a text edit on device B between syncs would silently
//! drop one change. Do not bolt on a naive timestamp merge later. Instead,
//! when that need arrives, either (a) restrict remote backends to
//! single-writer/single-device use documented as such, or (b) switch the
//! `Item` representation to an Automerge/Yjs CRDT document per item so
//! concurrent field edits merge instead of clobbering. Deciding this later is
//! fine — the `Store` trait boundary below is exactly where that change would
//! land, and no caller code should need to change.

mod local;

pub use local::LocalSqliteStore;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Note,
    Todo,
    Link,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub text: String,
    pub done: bool,
    /// Sorts above everything else and is what the `@bookmarks` filter
    /// matches on (renamed from `pinned` — one flag, not two, matching how
    /// both reference apps only have a single such concept).
    pub bookmarked: bool,
    pub rank: f64,
    pub source_app: Option<String>,
    pub created_at: String,
}

/// The seam a backend must satisfy. `LocalSqliteStore` is the only
/// implementation today; remote backends (atproto, S3 — see shiftshift's
/// prior art) are intentionally not ported yet, so there is no multi-backend
/// selection logic to keep in sync with a schema that doesn't exist yet.
pub trait Store: Send + Sync {
    fn list_items(&self) -> Result<Vec<Item>, String>;
    fn add_item(&self, text: &str, kind: ItemKind, source_app: Option<String>) -> Result<Item, String>;
    fn toggle_done(&self, id: &str) -> Result<(), String>;
    fn toggle_bookmarked(&self, id: &str) -> Result<(), String>;
    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String>;
    fn delete_item(&self, id: &str) -> Result<(), String>;
    fn clear_completed(&self) -> Result<(), String>;
}
