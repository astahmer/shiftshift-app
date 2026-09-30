//! Storage port. Everything above this module only knows `Item` and `Store` —
//! it never touches SQLite, a remote API, or a file format directly. This
//! mirrors shiftshift's ports-and-adapters split (see its `store/types.ts`),
//! deliberately kept as "pick one backend, run it exclusively" rather than a
//! CRDT-merged multi-writer store.
//!
//! CONFLICT RESOLUTION: `S3Store` takes option (a) below — single-writer,
//! single-device, documented as such (see its module doc). A single device
//! writing to a single backend has no conflicts. The moment two devices sync
//! through the same remote backend (e.g. two Macs pointed at one S3 bucket),
//! naive read-modify-write is NOT safe for concurrent edits: a toggle on
//! device A and a text edit on device B between syncs can silently drop one
//! change. If that need ever arrives, either (a) keep restricting remote
//! backends to one device at a time, or (b) switch `Item` to an
//! Automerge/Yjs CRDT document per item so concurrent field edits merge
//! instead of clobbering — the `Store` trait boundary below is exactly
//! where that change would land, and no caller code should need to change.

mod folder;
#[path = "image-assets.rs"]
mod image_assets;
mod local;
mod s3;
#[cfg(test)]
#[path = "sync-e2e.rs"]
mod sync_e2e;

pub use folder::{FolderMergeReport, FolderStore};
pub use local::LocalSqliteStore;
pub use s3::S3Store;

use serde::{Deserialize, Serialize};

const MAX_TAG_LENGTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Note,
    Todo,
    Link,
    /// `text` holds the absolute path to a PNG file under the app data dir
    /// (see `images.rs`) rather than the item's actual content.
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub item_id: Option<String>,
    /// Small fixed vocabulary (created/edited/deleted/kind_changed/
    /// bookmarked/unbookmarked/done/undone/used), left as a string rather
    /// than an enum so a future backend can log its own events without
    /// widening a shared enum.
    pub action: String,
    pub detail: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub text: String,
    /// Organization metadata, kept separate from the copyable text payload.
    /// `default` keeps older SQLite/folder/S3 records readable.
    #[serde(default)]
    pub tags: Vec<String>,
    pub done: bool,
    /// Sorts above everything else and is what the `@bookmarks` filter
    /// matches on (renamed from `pinned` — one flag, not two, matching how
    /// both reference apps only have a single such concept).
    pub bookmarked: bool,
    pub rank: f64,
    pub source_app: Option<String>,
    pub created_at: String,
    /// Derived from `history`'s "used" events, not a stored fact about the
    /// item — recomputed by `apply_copy_stats` on every `list_items` call
    /// rather than kept in sync by every mutation. Whatever value ends up
    /// persisted to disk in between (e.g. via `S3Store::put_item`) is
    /// harmless leftover, since it's always overwritten before being read.
    #[serde(default)]
    pub copy_count: i64,
    #[serde(default)]
    pub first_copied_at: Option<String>,
    #[serde(default)]
    pub last_copied_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionField {
    Tag,
    Kind,
    Done,
    Bookmarked,
    SourceApp,
    Text,
    CreatedAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionOperator {
    Equals,
    Contains,
    Before,
    After,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionPredicate {
    pub field: CollectionField,
    pub operator: CollectionOperator,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CollectionQuery {
    /// Every predicate in this group must match.
    pub all: Vec<CollectionPredicate>,
    /// At least one predicate must match when this group is non-empty.
    pub any: Vec<CollectionPredicate>,
    /// No predicate in this group may match.
    pub none: Vec<CollectionPredicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub query: CollectionQuery,
    pub sort: String,
    pub rank: f64,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for Collection {
    fn default() -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: String::new(),
            name: String::new(),
            query: CollectionQuery::default(),
            sort: "manual".to_string(),
            rank: 0.0,
            icon: None,
            color: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

/// Normalizes one tag at the storage boundary so manual edits, automation,
/// and imported records all use the same matching key.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut separator = false;
    for character in raw.trim().trim_start_matches('#').chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            normalized.push(character.to_ascii_lowercase());
            separator = false;
        } else if character.is_whitespace() && !normalized.is_empty() && !separator {
            normalized.push('-');
            separator = true;
        }
    }
    while normalized.ends_with('-') {
        normalized.pop();
    }
    let first = normalized.chars().next()?;
    if normalized.is_empty()
        || normalized.len() > MAX_TAG_LENGTH
        || !(first.is_ascii_alphabetic() || first == '_')
    {
        return None;
    }
    Some(normalized)
}

pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for raw in tags {
        let Some(tag) = normalize_tag(raw) else {
            continue;
        };
        if !normalized.iter().any(|existing| existing == &tag) {
            normalized.push(tag);
        }
    }
    normalized
}

/// Rejects malformed collection records before any backend writes them. The
/// query is intentionally small and typed so no backend ever executes user
/// supplied SQL or code.
pub fn validate_collection(collection: &Collection) -> Result<(), String> {
    if collection.id.trim().is_empty() {
        return Err("collection id is required".to_string());
    }
    if collection.id.len() > 160 {
        return Err("collection id is too long".to_string());
    }
    if !collection.id.bytes().all(|character| {
        character.is_ascii_alphanumeric() || character == b'-' || character == b'_'
    }) {
        return Err(
            "collection id may only contain letters, numbers, hyphens, and underscores".to_string(),
        );
    }
    if collection.name.trim().is_empty() {
        return Err("collection name is required".to_string());
    }
    if collection.name.len() > 200 {
        return Err("collection name is too long".to_string());
    }
    if !matches!(
        collection.sort.as_str(),
        "manual" | "newest" | "oldest" | "az" | "za"
    ) {
        return Err(format!("unsupported collection sort: {}", collection.sort));
    }
    for predicate in collection
        .query
        .all
        .iter()
        .chain(collection.query.any.iter())
        .chain(collection.query.none.iter())
    {
        let compatible = match predicate.field {
            CollectionField::Tag
            | CollectionField::Kind
            | CollectionField::Done
            | CollectionField::Bookmarked => predicate.operator == CollectionOperator::Equals,
            CollectionField::SourceApp | CollectionField::Text => matches!(
                predicate.operator,
                CollectionOperator::Equals | CollectionOperator::Contains
            ),
            CollectionField::CreatedAt => matches!(
                predicate.operator,
                CollectionOperator::Before | CollectionOperator::After
            ),
        };
        if !compatible {
            return Err(format!(
                "operator {:?} is not valid for field {:?}",
                predicate.operator, predicate.field
            ));
        }
        if predicate.value.len() > 1000 {
            return Err("collection predicate value is too long".to_string());
        }
    }
    Ok(())
}

/// Recomputes each item's copy-tracking fields (Raycard-style "times copied /
/// first copied / last copied") from the "used" events in `history` — the
/// single source of truth, so no mutation path needs to remember to keep a
/// separate counter in sync.
pub fn apply_copy_stats(items: &mut [Item], history: &[HistoryEntry]) {
    let mut statistics: std::collections::HashMap<&str, (i64, &str, &str)> =
        std::collections::HashMap::new();
    for entry in history.iter().filter(|entry| entry.action == "used") {
        let Some(item_id) = entry.item_id.as_deref() else {
            continue;
        };
        let statistics = statistics
            .entry(item_id)
            .or_insert((0, &entry.at, &entry.at));
        statistics.0 += 1;
        statistics.1 = statistics.1.min(&entry.at);
        statistics.2 = statistics.2.max(&entry.at);
    }
    for item in items {
        let statistics = statistics.get(item.id.as_str());
        item.copy_count = statistics.map_or(0, |statistics| statistics.0);
        item.first_copied_at = statistics.map(|statistics| statistics.1.to_string());
        item.last_copied_at = statistics.map(|statistics| statistics.2.to_string());
    }
}

/// Fractional-rank reordering (shiftshift's `computeMoveRank`, mirrored for
/// our DESC display order where the highest rank sorts first): the rank
/// `id` (found in `items`, already in display order) needs so it ends up one
/// slot over in `direction`, landing between its new neighbors rather than
/// requiring the whole list to be renumbered. `None` at an edge (nothing to
/// move past) — the caller should treat that as a no-op, not an error.
/// Shared by every `Store` implementation, so this only needs testing once.
pub fn compute_move_rank(items: &[Item], id: &str, direction: MoveDirection) -> Option<f64> {
    let index = items.iter().position(|i| i.id == id)?;
    let target_index = match direction {
        MoveDirection::Up => index.checked_sub(1),
        MoveDirection::Down => (index + 1 < items.len()).then_some(index + 1),
    }?;
    let beyond_index = match direction {
        MoveDirection::Up => target_index.checked_sub(1),
        MoveDirection::Down => (target_index + 1 < items.len()).then_some(target_index + 1),
    };
    let boundary = items[target_index].rank;
    Some(match beyond_index {
        Some(i) => (boundary + items[i].rank) / 2.0,
        None => match direction {
            MoveDirection::Up => boundary + 1.0,
            MoveDirection::Down => boundary - 1.0,
        },
    })
}

/// The seam a backend must satisfy. `LocalSqliteStore` is the local SQLite
/// backend; `S3Store` is the remote one (see its module doc for the
/// single-writer caveat). Selection lives in `db.rs`, reading the choice
/// from `Settings::backend`.
pub trait Store: Send + Sync {
    fn list_items(&self) -> Result<Vec<Item>, String>;
    fn list_collections(&self) -> Result<Vec<Collection>, String>;
    fn save_collection(&self, collection: Collection) -> Result<(), String>;
    fn delete_collection(&self, id: &str) -> Result<(), String>;
    fn add_item(
        &self,
        text: &str,
        kind: ItemKind,
        source_app: Option<String>,
    ) -> Result<Item, String>;
    fn toggle_done(&self, id: &str) -> Result<(), String>;
    fn toggle_bookmarked(&self, id: &str) -> Result<(), String>;
    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String>;
    fn set_tags(&self, id: &str, tags: Vec<String>) -> Result<(), String>;
    fn update_text(&self, id: &str, text: &str) -> Result<(), String>;
    fn delete_item(&self, id: &str) -> Result<(), String>;
    fn clear_completed(&self) -> Result<(), String>;
    fn move_item(&self, id: &str, direction: MoveDirection) -> Result<(), String>;
    /// Re-inserts a full item as-is (same id/rank/timestamps) — the undo side
    /// of a delete, and the redo side of an add. Never called with a
    /// hand-built `Item`; always one previously returned by this trait.
    fn restore_item(&self, item: Item) -> Result<(), String>;
    /// Sets a rank directly rather than computing a relative move — undo/redo
    /// for `move_item`, which only exposes "one slot up/down", not "back to
    /// exactly where it was".
    fn set_rank(&self, id: &str, rank: f64) -> Result<(), String>;
    fn log_event(
        &self,
        item_id: Option<&str>,
        action: &str,
        detail: Option<&str>,
    ) -> Result<(), String>;
    fn list_history(&self, limit: u32) -> Result<Vec<HistoryEntry>, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, rank: f64) -> Item {
        Item {
            id: id.to_string(),
            kind: ItemKind::Note,
            text: id.to_string(),
            tags: Vec::new(),
            done: false,
            bookmarked: false,
            rank,
            source_app: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            copy_count: 0,
            first_copied_at: None,
            last_copied_at: None,
        }
    }

    #[test]
    fn apply_copy_stats_counts_used_events_and_tracks_first_and_last() {
        let mut items = vec![item("a", 1.0), item("b", 2.0)];
        let history = vec![
            HistoryEntry {
                id: "1".into(),
                item_id: Some("a".into()),
                action: "used".into(),
                detail: None,
                at: "2026-01-01T00:00:00Z".into(),
            },
            HistoryEntry {
                id: "2".into(),
                item_id: Some("a".into()),
                action: "used".into(),
                detail: None,
                at: "2026-01-03T00:00:00Z".into(),
            },
            HistoryEntry {
                id: "3".into(),
                item_id: Some("a".into()),
                action: "used".into(),
                detail: None,
                at: "2026-01-02T00:00:00Z".into(),
            },
            HistoryEntry {
                id: "4".into(),
                item_id: Some("b".into()),
                action: "created".into(),
                detail: None,
                at: "2026-01-01T00:00:00Z".into(),
            },
        ];
        apply_copy_stats(&mut items, &history);
        assert_eq!(items[0].copy_count, 3);
        assert_eq!(
            items[0].first_copied_at.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            items[0].last_copied_at.as_deref(),
            Some("2026-01-03T00:00:00Z")
        );
        assert_eq!(items[1].copy_count, 0);
        assert_eq!(items[1].first_copied_at, None);
    }

    #[test]
    fn normalizes_tags_and_deduplicates_them() {
        let tags = vec![
            "#Work Queue".to_string(),
            "work-queue".to_string(),
            "482".to_string(),
            "_private".to_string(),
        ];
        assert_eq!(normalize_tags(&tags), vec!["work-queue", "_private"]);
    }

    #[test]
    fn validates_collection_ids_and_query_operators() {
        let mut collection = Collection {
            id: "work_queue".to_string(),
            name: "Work queue".to_string(),
            query: CollectionQuery {
                all: vec![CollectionPredicate {
                    field: CollectionField::Tag,
                    operator: CollectionOperator::Equals,
                    value: "work".to_string(),
                }],
                ..CollectionQuery::default()
            },
            sort: "newest".to_string(),
            rank: 1.0,
            icon: None,
            color: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        assert!(validate_collection(&collection).is_ok());

        collection.id = "../escape".to_string();
        assert!(validate_collection(&collection).is_err());
        collection.id = "work_queue".to_string();
        collection.query.all[0].operator = CollectionOperator::Contains;
        assert!(validate_collection(&collection).is_err());
    }

    #[test]
    fn move_up_lands_between_the_target_and_its_far_neighbor() {
        // Display order (rank DESC): c(3), b(2), a(1) — moving a up one slot
        // should land it between b and c.
        let items = vec![item("c", 3.0), item("b", 2.0), item("a", 1.0)];
        let rank = compute_move_rank(&items, "a", MoveDirection::Up).unwrap();
        assert!(rank > 2.0 && rank < 3.0);
    }

    #[test]
    fn move_up_at_the_top_extends_past_the_current_max() {
        let items = vec![item("c", 3.0), item("b", 2.0), item("a", 1.0)];
        let rank = compute_move_rank(&items, "c", MoveDirection::Up);
        assert_eq!(rank, None); // already first, nothing to move past
    }

    #[test]
    fn move_down_lands_between_the_target_and_its_far_neighbor() {
        let items = vec![item("c", 3.0), item("b", 2.0), item("a", 1.0)];
        let rank = compute_move_rank(&items, "c", MoveDirection::Down).unwrap();
        assert!(rank > 1.0 && rank < 2.0);
    }

    #[test]
    fn move_down_at_the_bottom_is_none() {
        let items = vec![item("c", 3.0), item("b", 2.0), item("a", 1.0)];
        assert_eq!(compute_move_rank(&items, "a", MoveDirection::Down), None);
    }

    #[test]
    fn unknown_id_is_none() {
        let items = vec![item("a", 1.0)];
        assert_eq!(
            compute_move_rank(&items, "missing", MoveDirection::Up),
            None
        );
    }
}
