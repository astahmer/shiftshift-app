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

mod local;
mod s3;

pub use local::LocalSqliteStore;
pub use s3::S3Store;

use serde::{Deserialize, Serialize};

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

/// Recomputes each item's copy-tracking fields (Raycard-style "times copied /
/// first copied / last copied") from the "used" events in `history` — the
/// single source of truth, so no mutation path needs to remember to keep a
/// separate counter in sync.
pub fn apply_copy_stats(items: &mut [Item], history: &[HistoryEntry]) {
    for item in items.iter_mut() {
        let mut count = 0i64;
        let mut first: Option<&str> = None;
        let mut last: Option<&str> = None;
        for entry in history.iter().filter(|h| h.action == "used" && h.item_id.as_deref() == Some(item.id.as_str())) {
            count += 1;
            if first.is_none_or(|f| entry.at.as_str() < f) {
                first = Some(entry.at.as_str());
            }
            if last.is_none_or(|l| entry.at.as_str() > l) {
                last = Some(entry.at.as_str());
            }
        }
        item.copy_count = count;
        item.first_copied_at = first.map(|s| s.to_string());
        item.last_copied_at = last.map(|s| s.to_string());
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
    fn add_item(&self, text: &str, kind: ItemKind, source_app: Option<String>) -> Result<Item, String>;
    fn toggle_done(&self, id: &str) -> Result<(), String>;
    fn toggle_bookmarked(&self, id: &str) -> Result<(), String>;
    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String>;
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
    fn log_event(&self, item_id: Option<&str>, action: &str, detail: Option<&str>) -> Result<(), String>;
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
            HistoryEntry { id: "1".into(), item_id: Some("a".into()), action: "used".into(), detail: None, at: "2026-01-01T00:00:00Z".into() },
            HistoryEntry { id: "2".into(), item_id: Some("a".into()), action: "used".into(), detail: None, at: "2026-01-03T00:00:00Z".into() },
            HistoryEntry { id: "3".into(), item_id: Some("a".into()), action: "used".into(), detail: None, at: "2026-01-02T00:00:00Z".into() },
            HistoryEntry { id: "4".into(), item_id: Some("b".into()), action: "created".into(), detail: None, at: "2026-01-01T00:00:00Z".into() },
        ];
        apply_copy_stats(&mut items, &history);
        assert_eq!(items[0].copy_count, 3);
        assert_eq!(items[0].first_copied_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(items[0].last_copied_at.as_deref(), Some("2026-01-03T00:00:00Z"));
        assert_eq!(items[1].copy_count, 0);
        assert_eq!(items[1].first_copied_at, None);
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
        assert_eq!(compute_move_rank(&items, "missing", MoveDirection::Up), None);
    }
}
