use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::{Item, ItemKind, Store};

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
                _ => ItemKind::Note,
            },
            text: row.get("text")?,
            done: row.get::<_, i64>("done")? != 0,
            bookmarked: row.get::<_, i64>("bookmarked")? != 0,
            rank: row.get("rank")?,
            source_app: row.get("source_app")?,
            created_at: row.get("created_at")?,
        })
    }
}

fn kind_str(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Note => "note",
        ItemKind::Todo => "todo",
        ItemKind::Link => "link",
    }
}

impl Store for LocalSqliteStore {
    fn list_items(&self) -> Result<Vec<Item>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM items ORDER BY bookmarked DESC, rank DESC, created_at DESC")
            .map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], Self::row_to_item)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(items)
    }

    fn add_item(&self, text: &str, kind: ItemKind, source_app: Option<String>) -> Result<Item, String> {
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text: text.to_string(),
            done: false,
            bookmarked: false,
            rank: chrono::Utc::now().timestamp_millis() as f64,
            source_app,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
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
}
