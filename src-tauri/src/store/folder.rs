//! Folder-based sync backend — the same one-JSON-object-per-item shape as
//! `S3Store`, but written straight to a plain local directory instead of a
//! bucket. Point it at an iCloud Drive / Dropbox / Syncthing folder and you
//! get multi-device sync for free, with no API keys, no cloud account, and
//! no network code of our own — the filesystem sync client does all of it.
//!
//! Same single-writer caveat as `S3Store` (see `store/mod.rs`'s module doc):
//! this is read-modify-write per item with no locking, so two devices
//! editing the same item between sync passes can still clobber each other.
//! It's a materially *smaller* window than S3 in practice, since a sync
//! client round-trips in seconds rather than requiring an explicit push,
//! but it is not a CRDT and doesn't pretend to be one.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use super::image_assets::{write_bytes, ImageAssets};

use super::{
    apply_copy_stats, compute_move_rank, Collection, HistoryEntry, Item, ItemKind, MoveDirection,
    Store,
};

pub struct FolderStore {
    items_dir: PathBuf,
    assets_dir: PathBuf,
    images: ImageAssets,
    history_dir: PathBuf,
    collections_dir: PathBuf,
    items_cache: Mutex<RecordCache<Item>>,
    history_cache: Mutex<RecordCache<HistoryEntry>>,
    collections_cache: Mutex<RecordCache<Collection>>,
}

struct CachedRecord<T> {
    modified: SystemTime,
    length: u64,
    value: T,
}

type RecordCache<T> = HashMap<PathBuf, CachedRecord<T>>;

fn read_records<T: serde::de::DeserializeOwned + Clone>(
    directory: &Path,
    cache: &Mutex<RecordCache<T>>,
) -> Result<Vec<T>, String> {
    let mut cache = cache.lock().map_err(|error| error.to_string())?;
    let mut present = HashSet::new();
    let mut records = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let modified = metadata.modified().map_err(|error| error.to_string())?;
        let length = metadata.len();
        let unchanged = cache
            .get(&path)
            .filter(|record| record.modified == modified && record.length == length);
        let value = match unchanged {
            Some(record) => record.value.clone(),
            None => {
                let raw = match fs::read(&path) {
                    Ok(raw) => raw,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.to_string()),
                };
                let value: T = serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
                cache.insert(
                    path.clone(),
                    CachedRecord {
                        modified,
                        length,
                        value: value.clone(),
                    },
                );
                value
            }
        };
        present.insert(path);
        records.push(value);
    }
    cache.retain(|path, _| present.contains(path));
    Ok(records)
}

fn write_record<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    write_bytes(path, &bytes)
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct FolderMergeReport {
    pub items_added: usize,
    pub items_existing: usize,
    pub history_added: usize,
    pub history_existing: usize,
    pub collections_added: usize,
    pub collections_existing: usize,
}

/// `Path` doesn't expand `~` itself — users will naturally type a `~/...`
/// path (e.g. into iCloud Drive), so this is the difference between "just
/// works" and a folder silently created next to the app data dir instead.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

impl FolderStore {
    fn root_for(folder_path: &str) -> Result<PathBuf, String> {
        if folder_path.trim().is_empty() {
            return Err("folder backend needs a directory path".to_string());
        }
        Ok(PathBuf::from(expand_tilde(folder_path)))
    }

    fn ensure_layout(root: &Path) -> Result<(), String> {
        fs::create_dir_all(root.join("items")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("history")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("collections")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("assets")).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Creates the folder layout without switching the active backend. This
    /// lets the settings UI prove that setup succeeded before the required
    /// restart constructs the live `FolderStore`.
    pub fn prepare(folder_path: &str) -> Result<String, String> {
        let root = Self::root_for(folder_path)?;
        Self::ensure_layout(&root)?;
        Ok(root.to_string_lossy().into_owned())
    }

    pub fn open(folder_path: &str) -> Result<Self, String> {
        let image_cache =
            std::env::temp_dir().join(format!("shiftshift-image-cache-{}", uuid::Uuid::new_v4()));
        Self::open_with_image_cache(folder_path, image_cache)
    }

    pub fn open_with_image_cache(folder_path: &str, image_cache: PathBuf) -> Result<Self, String> {
        let root = Self::root_for(folder_path)?;
        Self::ensure_layout(&root)?;
        Ok(Self {
            items_dir: root.join("items"),
            assets_dir: root.join("assets"),
            images: ImageAssets::new(image_cache)?,
            history_dir: root.join("history"),
            collections_dir: root.join("collections"),
            items_cache: Mutex::new(HashMap::new()),
            history_cache: Mutex::new(HashMap::new()),
            collections_cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn has_items(&self) -> Result<bool, String> {
        for entry in fs::read_dir(&self.items_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn item_path(&self, id: &str) -> PathBuf {
        self.items_dir.join(format!("{id}.json"))
    }

    fn history_path(&self, id: &str) -> PathBuf {
        self.history_dir.join(format!("{id}.json"))
    }

    fn collection_path(&self, id: &str) -> PathBuf {
        self.collections_dir.join(format!("{id}.json"))
    }

    fn read_item(&self, id: &str) -> Result<Item, String> {
        let raw = fs::read_to_string(self.item_path(id)).map_err(|e| e.to_string())?;
        let mut item = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        self.resolve_image(&mut item)?;
        Ok(item)
    }

    fn resolve_image(&self, item: &mut Item) -> Result<(), String> {
        self.images.resolve(item, |identifier| {
            fs::read(self.assets_dir.join(format!("{identifier}.png")))
                .map_err(|error| error.to_string())
        })
    }

    fn write_item(&self, item: &Item) -> Result<(), String> {
        let encoded = self.images.encode(item, |identifier, bytes| {
            write_bytes(&self.assets_dir.join(format!("{identifier}.png")), bytes)
        })?;
        write_record(&self.item_path(&item.id), &encoded)
    }

    fn read_all_items(&self) -> Result<Vec<Item>, String> {
        let mut items = read_records(&self.items_dir, &self.items_cache)?;
        for item in &mut items {
            self.resolve_image(item)?;
        }
        Ok(items)
    }

    fn read_all_history(&self) -> Result<Vec<HistoryEntry>, String> {
        read_records(&self.history_dir, &self.history_cache)
    }

    fn read_all_collections(&self) -> Result<Vec<Collection>, String> {
        let mut collections = read_records(&self.collections_dir, &self.collections_cache)?;
        collections.sort_by(|a, b| {
            b.rank
                .total_cmp(&a.rank)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(collections)
    }

    fn write_collection(&self, collection: &Collection) -> Result<(), String> {
        write_record(&self.collection_path(&collection.id), collection)
    }

    fn write_history(&self, entry: &HistoryEntry) -> Result<(), String> {
        write_record(&self.history_path(&entry.id), entry)
    }

    /// Adds records that are missing from this folder without deleting or
    /// replacing records already synced there. This makes switching from the
    /// local backend additive and safe after a partial iCloud setup.
    pub fn merge_from(&self, source: &dyn Store) -> Result<FolderMergeReport, String> {
        let source_items = source.list_items()?;
        let source_history = source.list_history(u32::MAX)?;
        let source_collections = source.list_collections()?;
        let mut existing_items: HashSet<String> = self
            .read_all_items()?
            .into_iter()
            .map(|item| item.id)
            .collect();
        let mut existing_history: HashSet<String> = self
            .read_all_history()?
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        let mut existing_collections: HashSet<String> = self
            .read_all_collections()?
            .into_iter()
            .map(|collection| collection.id)
            .collect();
        let mut report = FolderMergeReport::default();

        for item in source_items {
            if existing_items.insert(item.id.clone()) {
                self.write_item(&item)?;
                report.items_added += 1;
            } else {
                report.items_existing += 1;
            }
        }
        for entry in source_history {
            if existing_history.insert(entry.id.clone()) {
                self.write_history(&entry)?;
                report.history_added += 1;
            } else {
                report.history_existing += 1;
            }
        }
        for collection in source_collections {
            if existing_collections.insert(collection.id.clone()) {
                self.write_collection(&collection)?;
                report.collections_added += 1;
            } else {
                report.collections_existing += 1;
            }
        }
        Ok(report)
    }
}

impl Store for FolderStore {
    fn list_items(&self) -> Result<Vec<Item>, String> {
        let mut items = self.read_all_items()?;
        items.sort_by(|a, b| {
            b.bookmarked
                .cmp(&a.bookmarked)
                .then(b.rank.total_cmp(&a.rank))
                .then(b.created_at.cmp(&a.created_at))
        });
        let history = self.read_all_history()?;
        apply_copy_stats(&mut items, &history);
        Ok(items)
    }

    fn list_collections(&self) -> Result<Vec<Collection>, String> {
        self.read_all_collections()
    }

    fn save_collection(&self, collection: Collection) -> Result<(), String> {
        super::validate_collection(&collection)?;
        self.write_collection(&collection)
    }

    fn delete_collection(&self, id: &str) -> Result<(), String> {
        fs::remove_file(self.collection_path(id)).map_err(|e| e.to_string())
    }

    fn add_item(
        &self,
        text: &str,
        kind: ItemKind,
        source_app: Option<String>,
    ) -> Result<Item, String> {
        let max_rank = self
            .read_all_items()?
            .iter()
            .map(|i| i.rank)
            .fold(0.0, f64::max);
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
        self.write_item(&item)?;
        self.read_item(&item.id)
    }

    fn toggle_done(&self, id: &str) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.done = !item.done;
        self.write_item(&item)
    }

    fn toggle_bookmarked(&self, id: &str) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.bookmarked = !item.bookmarked;
        self.write_item(&item)
    }

    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.kind = kind;
        self.write_item(&item)
    }

    fn set_tags(&self, id: &str, tags: Vec<String>) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.tags = super::normalize_tags(&tags);
        self.write_item(&item)
    }

    fn update_text(&self, id: &str, text: &str) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.text = text.to_string();
        self.write_item(&item)
    }

    fn delete_item(&self, id: &str) -> Result<(), String> {
        fs::remove_file(self.item_path(id)).map_err(|e| e.to_string())
    }

    fn clear_completed(&self) -> Result<(), String> {
        for item in self.read_all_items()?.into_iter().filter(|i| i.done) {
            self.delete_item(&item.id)?;
        }
        Ok(())
    }

    fn move_item(&self, id: &str, direction: MoveDirection) -> Result<(), String> {
        let items = self.list_items()?;
        let Some(new_rank) = compute_move_rank(&items, id, direction) else {
            return Ok(());
        };
        let mut item = self.read_item(id)?;
        item.rank = new_rank;
        self.write_item(&item)
    }

    fn restore_item(&self, item: Item) -> Result<(), String> {
        self.write_item(&item)
    }

    fn set_rank(&self, id: &str, rank: f64) -> Result<(), String> {
        let mut item = self.read_item(id)?;
        item.rank = rank;
        self.write_item(&item)
    }

    fn log_event(
        &self,
        item_id: Option<&str>,
        action: &str,
        detail: Option<&str>,
    ) -> Result<(), String> {
        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            item_id: item_id.map(|s| s.to_string()),
            action: action.to_string(),
            detail: detail.map(|s| s.to_string()),
            at: chrono::Utc::now().to_rfc3339(),
        };
        self.write_history(&entry)
    }

    fn list_history(&self, limit: u32) -> Result<Vec<HistoryEntry>, String> {
        let mut entries = self.read_all_history()?;
        entries.sort_by(|a, b| b.at.cmp(&a.at));
        entries.truncate(limit as usize);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_never_observe_partial_local_writes() {
        let writer = store();
        let root = writer.items_dir.parent().unwrap().to_path_buf();
        let reader = FolderStore::open(root.to_str().unwrap()).unwrap();
        let item = writer.add_item("initial", ItemKind::Note, None).unwrap();
        std::thread::scope(|scope| {
            let item_id = &item.id;
            let writer_thread = scope.spawn(|| {
                for index in 0..100 {
                    writer
                        .update_text(item_id, &format!("{index}:{}", "x".repeat(32000)))
                        .unwrap();
                }
            });
            while !writer_thread.is_finished() {
                let records = reader.list_items().unwrap();
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].id, item.id);
            }
            writer_thread.join().unwrap();
        });
        assert!(reader.list_items().unwrap()[0].text.starts_with("99:"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_files_reuse_decoded_records_and_invalid_changes_fail_loudly() {
        let store = store();
        let item = store.add_item("cached", ItemKind::Note, None).unwrap();
        store.list_items().unwrap();
        store
            .items_cache
            .lock()
            .unwrap()
            .get_mut(&store.item_path(&item.id))
            .unwrap()
            .value
            .text = "cache hit".into();
        assert_eq!(store.list_items().unwrap()[0].text, "cache hit");
        fs::write(store.item_path(&item.id), "invalid external JSON").unwrap();
        assert!(store.list_items().is_err());
        write_record(&store.item_path(&item.id), &item).unwrap();
        assert_eq!(store.list_items().unwrap()[0].text, "cached");
        fs::remove_dir_all(store.items_dir.parent().unwrap()).unwrap();
    }

    fn store() -> FolderStore {
        let dir =
            std::env::temp_dir().join(format!("shiftshift-folder-test-{}", uuid::Uuid::new_v4()));
        FolderStore::open(dir.to_str().unwrap()).unwrap()
    }

    #[test]
    fn open_rejects_an_empty_path() {
        assert!(FolderStore::open("").is_err());
        assert!(FolderStore::open("   ").is_err());
    }

    #[test]
    fn expands_a_leading_tilde_using_home() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            expand_tilde("~/Documents/shiftshift"),
            format!("{home}/Documents/shiftshift")
        );
    }

    #[test]
    fn leaves_an_absolute_path_untouched() {
        assert_eq!(expand_tilde("/tmp/shiftshift"), "/tmp/shiftshift");
    }

    #[test]
    fn prepare_creates_the_folder_layout_and_returns_the_expanded_path() {
        let root =
            std::env::temp_dir().join(format!("shiftshift-prepare-test-{}", uuid::Uuid::new_v4()));
        let prepared = FolderStore::prepare(root.to_str().unwrap()).unwrap();
        assert_eq!(prepared, root.to_string_lossy());
        assert!(root.join("items").is_dir());
        assert!(root.join("history").is_dir());
    }

    #[test]
    fn reports_item_presence_without_reading_item_contents() {
        let s = store();
        assert!(!s.has_items().unwrap());
        s.add_item("present", ItemKind::Note, None).unwrap();
        assert!(s.has_items().unwrap());
    }

    #[test]
    fn merge_from_adds_missing_records_without_replacing_existing_items() {
        let source = store();
        let destination = store();
        let existing = source.add_item("existing", ItemKind::Note, None).unwrap();
        source
            .log_event(Some(&existing.id), "created", None)
            .unwrap();
        let missing = source.add_item("missing", ItemKind::Todo, None).unwrap();
        destination.restore_item(existing.clone()).unwrap();

        let report = destination.merge_from(&source).unwrap();

        assert_eq!(report.items_added, 1);
        assert_eq!(report.items_existing, 1);
        assert_eq!(report.history_added, 1);
        assert_eq!(destination.list_items().unwrap().len(), 2);
        assert!(destination
            .list_items()
            .unwrap()
            .iter()
            .any(|item| item.id == missing.id));
    }

    #[test]
    fn add_and_list_returns_the_item() {
        let s = store();
        let added = s.add_item("buy milk", ItemKind::Todo, None).unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, added.id);
        assert_eq!(items[0].text, "buy milk");
    }

    #[test]
    fn tags_and_collections_round_trip() {
        let s = store();
        let item = s.add_item("send report", ItemKind::Todo, None).unwrap();
        s.set_tags(&item.id, vec!["#Work Queue".into(), "work-queue".into()])
            .unwrap();
        assert_eq!(s.list_items().unwrap()[0].tags, vec!["work-queue"]);

        let collection = Collection {
            id: "work".into(),
            name: "Work queue".into(),
            query: Default::default(),
            sort: "manual".into(),
            rank: 10.0,
            icon: None,
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
    fn toggle_done_flips_the_flag() {
        let s = store();
        let item = s.add_item("task", ItemKind::Todo, None).unwrap();
        s.toggle_done(&item.id).unwrap();
        assert!(s.list_items().unwrap()[0].done);
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
        let item = s.add_item("undo me", ItemKind::Note, None).unwrap();
        let snapshot = s.list_items().unwrap()[0].clone();
        s.delete_item(&item.id).unwrap();
        s.restore_item(snapshot).unwrap();
        let items = s.list_items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, item.id);
    }

    #[test]
    fn log_event_and_list_history_round_trip_newest_first() {
        let s = store();
        let item = s.add_item("thing", ItemKind::Note, None).unwrap();
        s.log_event(Some(&item.id), "created", Some("thing"))
            .unwrap();
        s.log_event(Some(&item.id), "used", None).unwrap();
        let history = s.list_history(10).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].action, "used");
    }
}
