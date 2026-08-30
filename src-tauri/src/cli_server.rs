//! Listens for captures sent by the `shift` CLI binary. Each connection is
//! read line by line so a single call can submit several items (e.g. piped
//! multi-line stdin); every line becomes its own Note, matching how
//! `capture::do_capture` always lands selections as Notes rather than
//! guessing a kind.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;

use tauri::{AppHandle, Emitter, Manager};

use crate::cli_protocol::PORT;
use crate::db::Db;
use crate::store::ItemKind;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("shiftshift: CLI capture disabled, could not bind 127.0.0.1:{PORT}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let db = app.state::<Db>();
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Some(item) = add_line(&db, &line) {
                        let _ = app.emit("refresh", ());
                        crate::notify::notify_captured(&app, &item);
                    }
                }
            });
        }
    });
}

/// Adds one line of CLI input as a Note, skipping blank lines. Returns the
/// added item, so callers know whether a refresh/notification is warranted.
fn add_line(db: &Db, line: &str) -> Option<crate::store::Item> {
    let text = line.trim();
    if text.is_empty() {
        return None;
    }
    db.0.add_item(text, ItemKind::Note, Some("cli".to_string())).ok()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::store::LocalSqliteStore;

    fn db() -> Db {
        Db(Arc::new(LocalSqliteStore::open(std::path::Path::new(":memory:")).unwrap()))
    }

    #[test]
    fn adds_a_non_blank_line_as_a_cli_sourced_note() {
        let db = db();
        let item = add_line(&db, "buy milk").expect("should add an item");
        assert_eq!(item.text, "buy milk");
        assert_eq!(item.kind, ItemKind::Note);
        assert_eq!(item.source_app.as_deref(), Some("cli"));
        assert_eq!(db.0.list_items().unwrap().len(), 1);
    }

    #[test]
    fn skips_a_blank_line() {
        let db = db();
        assert!(add_line(&db, "   ").is_none());
        assert!(db.0.list_items().unwrap().is_empty());
    }
}
