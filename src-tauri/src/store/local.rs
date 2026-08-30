use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::{HistoryEntry, Item, ItemKind, MoveDirection, Store};

pub struct LocalSqliteStore {
    conn: Mutex<Connection>,
}

impl LocalSqliteStore {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
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
            );",
        )
        .map_err(|e| e.to_string())?;
        Self::migrate_pinned_to_bookmarked(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
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

    fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<Item> {
        let kind_str: String = row.get("kind")?;
        Ok(Item {
            id: row.get("id")?,
            kind: match kind_str.as_str() {
                "todo" => ItemKind::Todo,
                "link" => ItemKind::Link,
                "image" => ItemKind::Image,
                _ => ItemKind::Note,
            },
            text: row.get("text")?,
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

    fn add_item(&self, text: &str, kind: ItemKind, source_app: Option<String>) -> Result<Item, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Derived from the current max rather than a wall-clock timestamp:
        // items inserted within the same millisecond (a fast test, several
        // CLI lines piped in one call, clipboard-watch catching up) would
        // otherwise tie, making sort order and move_item's neighbor-midpoint
        // math silently no-op against equal ranks.
        let max_rank: f64 = conn
            .query_row("SELECT COALESCE(MAX(rank), 0) FROM items", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text: text.to_string(),
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
            "INSERT INTO items (id, kind, text, done, bookmarked, rank, source_app, created_at)
             VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, ?6)",
            params![
                item.id,
                kind_str(item.kind),
                item.text,
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
        conn.execute("UPDATE items SET done = NOT done WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn toggle_bookmarked(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE items SET bookmarked = NOT bookmarked WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE items SET kind = ?1 WHERE id = ?2", params![kind_str(kind), id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_text(&self, id: &str, text: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("UPDATE items SET text = ?1 WHERE id = ?2", params![text, id])
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
        conn.execute("UPDATE items SET rank = ?1 WHERE id = ?2", params![new_rank, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn log_event(&self, item_id: Option<&str>, action: &str, detail: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO history (id, item_id, action, detail, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![uuid::Uuid::new_v4().to_string(), item_id, action, detail, chrono::Utc::now().to_rfc3339()],
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
        let bookmarked: i64 = conn.query_row("SELECT bookmarked FROM items WHERE id = 'id-1'", [], |r| r.get(0)).unwrap();
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
        s.log_event(Some(&item.id), "created", Some("thing")).unwrap();
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
}
