use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::{Collection, CollectionQuery, HistoryEntry, Item, ItemKind, MoveDirection, Store};
use crate::db_encryption::sql_quote;

const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    done INTEGER NOT NULL DEFAULT 0,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    rank REAL NOT NULL DEFAULT 0,
    source_app TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    sort TEXT NOT NULL DEFAULT 'manual',
    rank REAL NOT NULL DEFAULT 0,
    icon TEXT,
    color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);";

pub struct LocalSqliteStore {
    conn: Mutex<Connection>,
}

impl LocalSqliteStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_key(path, None)
    }

    /// `key` is `None` when `Settings::encrypt_local_storage` is off. A
    /// `Some` key on a plaintext file triggers a one-time migration
    /// (`migrate_plaintext_to_encrypted`); `None` against a file that's
    /// still encrypted from a previously-enabled setting falls back to the
    /// stored key rather than losing access to it — see `db_encryption`'s
    /// module doc for the key itself.
    pub fn open_with_key(path: &Path, key: Option<&str>) -> Result<Self, String> {
        let conn = match key {
            Some(k) => Self::open_encrypted(path, k)?,
            None => Self::open_plain_or_fallback(path)?,
        };
        conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
        Self::migrate_pinned_to_bookmarked(&conn)?;
        Self::migrate_tags(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn has_items(&self) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT EXISTS(SELECT 1 FROM items LIMIT 1)", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|exists| exists != 0)
        .map_err(|e| e.to_string())
    }

    fn is_readable(conn: &Connection) -> bool {
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .is_ok()
    }

    /// Opens `path` with SQLCipher's `key` pragma set. That's enough if the
    /// file is already encrypted with this key, or is fresh/empty. A file
    /// with pre-existing PLAINTEXT data doesn't get retroactively encrypted
    /// just by setting a key on it — SQLCipher fails to read the (actually
    /// unencrypted) pages as ciphertext, which `is_readable` below catches,
    /// triggering a one-time migration instead.
    fn open_encrypted(path: &Path, key: &str) -> Result<Connection, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("PRAGMA key = '{}';", sql_quote(key)))
            .map_err(|e| e.to_string())?;
        if Self::is_readable(&conn) {
            return Ok(conn);
        }
        drop(conn);
        Self::migrate_plaintext_to_encrypted(path, key)
    }

    /// `Settings::encrypt_local_storage` is off, but the file might still be
    /// encrypted from before it was turned off — falls back to the stored
    /// key rather than silently losing access to real data.
    fn open_plain_or_fallback(path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        if Self::is_readable(&conn) {
            return Ok(conn);
        }
        drop(conn);
        let key = crate::db_encryption::get_or_create_key()?;
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("PRAGMA key = '{}';", sql_quote(&key)))
            .map_err(|e| e.to_string())?;
        if Self::is_readable(&conn) {
            eprintln!("shiftshift: local database is still encrypted even though encryption is off in settings; using the stored key so it stays readable");
            Ok(conn)
        } else {
            Err("could not open the local database: it isn't valid SQLite, and the stored encryption key doesn't open it either".to_string())
        }
    }

    /// Copies an existing plaintext database into a freshly-encrypted one
    /// via SQLCipher's `sqlcipher_export()`, then swaps files. The
    /// plaintext original is kept alongside as a `.plaintext-backup`, never
    /// deleted, so a failed or interrupted migration can't lose data.
    fn migrate_plaintext_to_encrypted(path: &Path, key: &str) -> Result<Connection, String> {
        let encrypted_path = path.with_extension("sqlite3.encrypting");
        let _ = std::fs::remove_file(&encrypted_path); // clear a stale attempt, if any

        let plain_conn = Connection::open(path).map_err(|e| e.to_string())?;
        plain_conn
            .execute_batch(&format!(
                "ATTACH DATABASE '{}' AS encrypted KEY '{}';",
                sql_quote(&encrypted_path.to_string_lossy()),
                sql_quote(key)
            ))
            .map_err(|e| e.to_string())?;
        plain_conn
            .query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))
            .map_err(|e| e.to_string())?;
        plain_conn
            .execute_batch("DETACH DATABASE encrypted;")
            .map_err(|e| e.to_string())?;
        drop(plain_conn);

        let backup_path = path.with_extension("sqlite3.plaintext-backup");
        std::fs::rename(path, &backup_path).map_err(|e| e.to_string())?;
        std::fs::rename(&encrypted_path, path).map_err(|e| e.to_string())?;
        eprintln!(
            "shiftshift: migrated the local database to encrypted storage; the previous plaintext file is kept at {}",
            backup_path.display()
        );

        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("PRAGMA key = '{}';", sql_quote(key)))
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    /// One-off migration for databases created before `pinned` was renamed to
    /// `bookmarked`. `CREATE TABLE IF NOT EXISTS` above is a no-op against an
    /// existing table, so an old column would otherwise linger and every
    /// query referencing `bookmarked` would fail against it.
    fn migrate_pinned_to_bookmarked(conn: &Connection) -> Result<(), String> {
        let has_old_column: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('items') WHERE name = 'pinned'")
            .map_err(|e| e.to_string())?
            .query_row([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            > 0;
        if has_old_column {
            conn.execute_batch("ALTER TABLE items RENAME COLUMN pinned TO bookmarked;")
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Adds first-class tag storage to databases created before collections.
    /// Existing inline hashtag text remains readable and is treated as legacy
    /// metadata by the frontend until it is edited into the new field.
    fn migrate_tags(conn: &Connection) -> Result<(), String> {
        let has_tags: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('items') WHERE name = 'tags'")
            .map_err(|e| e.to_string())?
            .query_row([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            > 0;
        if !has_tags {
            conn.execute_batch("ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';")
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<Item> {
        let kind_str: String = row.get("kind")?;
        let tags_json: Option<String> = row.get("tags")?;
        Ok(Item {
            id: row.get("id")?,
            kind: match kind_str.as_str() {
                "todo" => ItemKind::Todo,
                "link" => ItemKind::Link,
                "image" => ItemKind::Image,
                _ => ItemKind::Note,
            },
            text: row.get("text")?,
            tags: tags_json
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default(),
            done: row.get::<_, i64>("done")? != 0,
            bookmarked: row.get::<_, i64>("bookmarked")? != 0,
            rank: row.get("rank")?,
            source_app: row.get("source_app")?,
            created_at: row.get("created_at")?,
            // Not stored columns — recomputed from history right after this
            // query returns, see `list_items`.
            copy_count: 0,
            first_copied_at: None,
            last_copied_at: None,
        })
    }
}

fn kind_str(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Note => "note",
        ItemKind::Todo => "todo",
        ItemKind::Link => "link",
        ItemKind::Image => "image",
    }
}

impl Store for LocalSqliteStore {
    fn list_items(&self) -> Result<Vec<Item>, String> {
        let mut items = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                // rowid as the final tiebreaker: rank/created_at are both
                // millisecond-resolution timestamps and can tie for items
                // inserted in rapid succession (a fast test, or several CLI
                // lines piped in one call), which would otherwise make sort
                // order nondeterministic between runs.
                .prepare("SELECT * FROM items ORDER BY bookmarked DESC, rank DESC, created_at DESC, rowid DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], Self::row_to_item)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }; // lock released here — list_history below takes it again
        let history = self.list_history(u32::MAX)?;
        super::apply_copy_stats(&mut items, &history);
        Ok(items)
    }

    fn list_collections(&self) -> Result<Vec<Collection>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, query, sort, rank, icon, color, created_at, updated_at FROM collections ORDER BY rank DESC, name COLLATE NOCASE ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let query_json: String = row.get("query")?;
                let query: CollectionQuery =
                    serde_json::from_str(&query_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            query_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(Collection {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    query,
                    sort: row.get("sort")?,
                    rank: row.get("rank")?,
                    icon: row.get("icon")?,
                    color: row.get("color")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    fn save_collection(&self, collection: Collection) -> Result<(), String> {
        super::validate_collection(&collection)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let query = serde_json::to_string(&collection.query).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO collections (id, name, query, sort, rank, icon, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                collection.id,
                collection.name,
                query,
                collection.sort,
                collection.rank,
                collection.icon,
                collection.color,
                collection.created_at,
                collection.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete_collection(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM collections WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn add_item(
        &self,
        text: &str,
        kind: ItemKind,
        source_app: Option<String>,
    ) -> Result<Item, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Derived from the current max rather than a wall-clock timestamp:
        // items inserted within the same millisecond (a fast test, several
        // CLI lines piped in one call, clipboard-watch catching up) would
        // otherwise tie, making sort order and move_item's neighbor-midpoint
        // math silently no-op against equal ranks.
        let max_rank: f64 = conn
            .query_row("SELECT COALESCE(MAX(rank), 0) FROM items", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text: text.to_string(),
            tags: Vec::new(),
            done: false,
            bookmarked: false,
            rank: max_rank + 1000.0,
            source_app,
            created_at: chrono::Utc::now().to_rfc3339(),
            copy_count: 0,
            first_copied_at: None,
            last_copied_at: None,
        };
        conn.execute(
            "INSERT INTO items (id, kind, text, tags, done, bookmarked, rank, source_app, created_at)
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?7)",
            params![
                item.id,
                kind_str(item.kind),
                item.text,
                serde_json::to_string(&item.tags).map_err(|e| e.to_string())?,
                item.rank,
                item.source_app,
                item.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(item)
    }

    fn toggle_done(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET done = NOT done WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn toggle_bookmarked(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET bookmarked = NOT bookmarked WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET kind = ?1 WHERE id = ?2",
            params![kind_str(kind), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_tags(&self, id: &str, tags: Vec<String>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json =
            serde_json::to_string(&super::normalize_tags(&tags)).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET tags = ?1 WHERE id = ?2",
            params![json, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_text(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET text = ?1 WHERE id = ?2",
            params![text, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn delete_item(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM items WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn clear_completed(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM items WHERE done = 1", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn move_item(&self, id: &str, direction: MoveDirection) -> Result<(), String> {
        let items = self.list_items()?;
        let Some(new_rank) = super::compute_move_rank(&items, id, direction) else {
            return Ok(()); // already at that edge, or id not found
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET rank = ?1 WHERE id = ?2",
            params![new_rank, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn restore_item(&self, item: Item) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO items (id, kind, text, tags, done, bookmarked, rank, source_app, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                item.id,
                kind_str(item.kind),
                item.text,
                serde_json::to_string(&super::normalize_tags(&item.tags))
                    .map_err(|e| e.to_string())?,
                item.done as i64,
                item.bookmarked as i64,
                item.rank,
                item.source_app,
                item.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_rank(&self, id: &str, rank: f64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE items SET rank = ?1 WHERE id = ?2",
            params![rank, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn log_event(
        &self,
        item_id: Option<&str>,
        action: &str,
        detail: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO history (id, item_id, action, detail, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                item_id,
                action,
                detail,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn list_history(&self, limit: u32) -> Result<Vec<HistoryEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM history ORDER BY at DESC LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let entries = stmt
            .query_map(params![limit], |row| {
                Ok(HistoryEntry {
                    id: row.get("id")?,
                    item_id: row.get("item_id")?,
                    action: row.get("action")?,
                    detail: row.get("detail")?,
                    at: row.get("at")?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> LocalSqliteStore {
        LocalSqliteStore::open(std::path::Path::new(":memory:")).unwrap()
    }

    #[test]
    fn add_and_list_returns_the_item() {
        let s = store();
        let added = s.add_item("buy milk", ItemKind::Todo, None).unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, added.id);
        assert_eq!(items[0].text, "buy milk");
        assert!(!items[0].done);
    }

    #[test]
    fn reports_item_presence_without_loading_items() {
        let s = store();
        assert!(!s.has_items().unwrap());
        s.add_item("present", ItemKind::Note, None).unwrap();
        assert!(s.has_items().unwrap());
    }

    #[test]
    fn toggle_done_flips_the_flag() {
        let s = store();
        let item = s.add_item("task", ItemKind::Todo, None).unwrap();
        s.toggle_done(&item.id).unwrap();
        assert!(s.list_items().unwrap()[0].done);
        s.toggle_done(&item.id).unwrap();
        assert!(!s.list_items().unwrap()[0].done);
    }

    #[test]
    fn bookmarked_items_sort_before_unbookmarked() {
        let s = store();
        let a = s.add_item("first", ItemKind::Note, None).unwrap();
        let _b = s.add_item("second", ItemKind::Note, None).unwrap();
        s.toggle_bookmarked(&a.id).unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items[0].id, a.id);
    }

    #[test]
    fn set_kind_changes_an_items_kind() {
        let s = store();
        let item = s.add_item("call mom", ItemKind::Note, None).unwrap();
        s.set_kind(&item.id, ItemKind::Todo).unwrap();
        assert_eq!(s.list_items().unwrap()[0].kind, ItemKind::Todo);
    }

    #[test]
    fn tags_and_collections_round_trip() {
        let s = store();
        let item = s
            .add_item("send report", ItemKind::Todo, Some("Mail".into()))
            .unwrap();
        s.set_tags(
            &item.id,
            vec!["#Work Queue".into(), "work-queue".into(), "482".into()],
        )
        .unwrap();
        assert_eq!(s.list_items().unwrap()[0].tags, vec!["work-queue"]);

        let collection = Collection {
            id: "work".into(),
            name: "Work queue".into(),
            query: CollectionQuery {
                all: vec![super::super::CollectionPredicate {
                    field: super::super::CollectionField::Tag,
                    operator: super::super::CollectionOperator::Equals,
                    value: "work-queue".into(),
                }],
                ..CollectionQuery::default()
            },
            sort: "newest".into(),
            rank: 10.0,
            icon: Some("▣".into()),
            color: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        s.save_collection(collection.clone()).unwrap();
        assert_eq!(s.list_collections().unwrap(), vec![collection]);
        s.delete_collection("work").unwrap();
        assert!(s.list_collections().unwrap().is_empty());
    }

    #[test]
    fn update_text_changes_an_items_text() {
        let s = store();
        let item = s.add_item("typo", ItemKind::Note, None).unwrap();
        s.update_text(&item.id, "fixed").unwrap();
        assert_eq!(s.list_items().unwrap()[0].text, "fixed");
    }

    #[test]
    fn migrates_a_legacy_pinned_column_to_bookmarked() {
        let conn = rusqlite::Connection::open(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "CREATE TABLE items (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
                rank REAL NOT NULL DEFAULT 0, source_app TEXT, created_at TEXT NOT NULL
            );
            INSERT INTO items VALUES ('id-1', 'note', 'legacy row', 0, 1, 0.0, NULL, '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        LocalSqliteStore::migrate_pinned_to_bookmarked(&conn).unwrap();
        let bookmarked: i64 = conn
            .query_row("SELECT bookmarked FROM items WHERE id = 'id-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(bookmarked, 1);
    }

    #[test]
    fn clear_completed_removes_only_done_items() {
        let s = store();
        let a = s.add_item("keep", ItemKind::Todo, None).unwrap();
        let b = s.add_item("drop", ItemKind::Todo, None).unwrap();
        s.toggle_done(&b.id).unwrap();
        s.clear_completed().unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, a.id);
    }

    #[test]
    fn delete_item_removes_it() {
        let s = store();
        let item = s.add_item("gone", ItemKind::Note, None).unwrap();
        s.delete_item(&item.id).unwrap();
        assert!(s.list_items().unwrap().is_empty());
    }

    #[test]
    fn restore_item_brings_back_a_deleted_item_with_the_same_id() {
        let s = store();
        let item = s.add_item("undo me", ItemKind::Todo, None).unwrap();
        s.toggle_bookmarked(&item.id).unwrap();
        let snapshot = s.list_items().unwrap()[0].clone();
        s.delete_item(&item.id).unwrap();
        assert!(s.list_items().unwrap().is_empty());
        s.restore_item(snapshot).unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, item.id);
        assert!(items[0].bookmarked);
    }

    #[test]
    fn set_rank_sets_an_exact_value() {
        let s = store();
        let item = s.add_item("reorder me", ItemKind::Note, None).unwrap();
        s.set_rank(&item.id, 42.5).unwrap();
        assert_eq!(s.list_items().unwrap()[0].rank, 42.5);
    }

    #[test]
    fn move_up_swaps_with_the_previous_item() {
        let s = store();
        let a = s.add_item("a", ItemKind::Note, None).unwrap(); // rank order after inserts: c, b, a (newest first)
        let b = s.add_item("b", ItemKind::Note, None).unwrap();
        let c = s.add_item("c", ItemKind::Note, None).unwrap();
        // list order is c, b, a; move a (last) up one slot -> c, a, b
        s.move_item(&a.id, MoveDirection::Up).unwrap();
        let ids: Vec<String> = s.list_items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![c.id, a.id, b.id]);
    }

    #[test]
    fn move_down_swaps_with_the_next_item() {
        let s = store();
        let a = s.add_item("a", ItemKind::Note, None).unwrap();
        let b = s.add_item("b", ItemKind::Note, None).unwrap();
        let c = s.add_item("c", ItemKind::Note, None).unwrap();
        // list order is c, b, a; move c (first) down one slot -> b, c, a
        s.move_item(&c.id, MoveDirection::Down).unwrap();
        let ids: Vec<String> = s.list_items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![b.id, c.id, a.id]);
    }

    #[test]
    fn move_up_at_the_top_is_a_no_op() {
        let s = store();
        let a = s.add_item("a", ItemKind::Note, None).unwrap();
        let b = s.add_item("b", ItemKind::Note, None).unwrap();
        s.move_item(&b.id, MoveDirection::Up).unwrap(); // b is already first
        let ids: Vec<String> = s.list_items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![b.id, a.id]);
    }

    #[test]
    fn log_event_and_list_history_round_trip_newest_first() {
        let s = store();
        let item = s.add_item("thing", ItemKind::Note, None).unwrap();
        s.log_event(Some(&item.id), "created", Some("thing"))
            .unwrap();
        s.log_event(Some(&item.id), "bookmarked", None).unwrap();
        let history = s.list_history(10).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].action, "bookmarked");
        assert_eq!(history[1].action, "created");
        assert_eq!(history[1].detail.as_deref(), Some("thing"));
    }

    #[test]
    fn list_history_respects_the_limit() {
        let s = store();
        for i in 0..5 {
            s.log_event(None, &format!("event-{i}"), None).unwrap();
        }
        assert_eq!(s.list_history(2).unwrap().len(), 2);
    }

    #[test]
    fn lists_ten_thousand_local_items() {
        let s = store();
        for i in 0..10_000 {
            s.add_item(&format!("bench-{i}"), ItemKind::Note, None)
                .unwrap();
        }
        let started = std::time::Instant::now();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 10_000);
        assert!(
            started.elapsed().as_millis() < 2_000,
            "list_items took {:?}",
            started.elapsed()
        );
    }

    // --- Encryption (SQLCipher) — real files, since this is about at-rest
    // persistence; `:memory:` databases have nothing on disk to encrypt.

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "shiftshift-encryption-test-{name}-{}.sqlite3",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn opens_a_fresh_database_with_a_key_and_reopens_it_with_the_same_key() {
        let path = temp_db_path("fresh");
        let key = "test-key-aaaa";
        {
            let store = LocalSqliteStore::open_with_key(&path, Some(key)).unwrap();
            store.add_item("secret note", ItemKind::Note, None).unwrap();
        }
        let reopened = LocalSqliteStore::open_with_key(&path, Some(key)).unwrap();
        let items = reopened.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "secret note");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wrong_key_cannot_read_an_encrypted_database() {
        let path = temp_db_path("wrong-key");
        {
            let store = LocalSqliteStore::open_with_key(&path, Some("correct-key")).unwrap();
            store.add_item("secret note", ItemKind::Note, None).unwrap();
        }
        assert!(LocalSqliteStore::open_with_key(&path, Some("wrong-key")).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn migrates_an_existing_plaintext_database_to_encrypted_and_keeps_a_backup() {
        let path = temp_db_path("migrate");
        {
            let plain = LocalSqliteStore::open(&path).unwrap();
            plain
                .add_item("pre-existing note", ItemKind::Note, None)
                .unwrap();
        }
        let key = "new-key-bbbb";
        let encrypted = LocalSqliteStore::open_with_key(&path, Some(key)).unwrap();
        let items = encrypted.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "pre-existing note");

        let backup_path = path.with_extension("sqlite3.plaintext-backup");
        assert!(
            backup_path.exists(),
            "plaintext backup should be kept, not deleted"
        );

        // The migrated file really is encrypted now, not just readable by
        // coincidence — the wrong key must fail against it. (Not testing
        // the no-key path here: that falls back to the real macOS Keychain,
        // which a test shouldn't read from or write to.)
        drop(encrypted);
        assert!(LocalSqliteStore::open_with_key(&path, Some("not-the-right-key")).is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup_path);
    }

    #[test]
    fn opening_without_a_key_still_works_on_a_plain_database() {
        let path = temp_db_path("plain-passthrough");
        {
            let store = LocalSqliteStore::open(&path).unwrap();
            store.add_item("plain note", ItemKind::Note, None).unwrap();
        }
        let reopened = LocalSqliteStore::open(&path).unwrap();
        assert_eq!(reopened.list_items().unwrap()[0].text, "plain note");
        let _ = std::fs::remove_file(&path);
    }
}
