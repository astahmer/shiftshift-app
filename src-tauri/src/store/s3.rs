//! S3-compatible remote backend — one JSON object per item/history entry,
//! mirroring shiftshift's simplest sync mode ("any S3-compatible bucket...
//! one JSON object per capture"). Works against AWS S3, R2, MinIO, or
//! anything else that speaks the S3 API, via `Region::Custom` with the
//! user-provided endpoint.
//!
//! SINGLE-WRITER ONLY (see the conflict-resolution note in `store/mod.rs`):
//! every mutation here is read-modify-write with no locking or optimistic
//! concurrency check. Two devices writing through the same bucket at
//! overlapping times can silently drop one device's change. Fine for one
//! person syncing one device's captures across machines *sequentially*; not
//! safe for simultaneous multi-device use.
//!
use super::image_assets::ImageAssets;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;

use super::{compute_move_rank, Collection, HistoryEntry, Item, ItemKind, MoveDirection, Store};
use crate::settings::S3Settings;

pub struct S3Store {
    bucket: Box<Bucket>,
    prefix: String,
    images: ImageAssets,
    items_cache: Mutex<ObjectCache<Item>>,
    history_cache: Mutex<ObjectCache<HistoryEntry>>,
    collections_cache: Mutex<ObjectCache<Collection>>,
}

type ObjectCache<T> = HashMap<String, (String, T)>;

fn check_status(status: u16) -> Result<(), String> {
    if !(200..300).contains(&status) {
        return Err(format!("S3 request failed with HTTP {status}"));
    }
    Ok(())
}

impl S3Store {
    pub fn open(settings: &S3Settings, image_cache: PathBuf) -> Result<Self, String> {
        if settings.bucket.is_empty() || settings.endpoint.is_empty() {
            return Err("S3 settings need at least a bucket and an endpoint".to_string());
        }
        let region = Region::Custom {
            region: settings.region.clone(),
            endpoint: settings.endpoint.clone(),
        };
        // The secret never lives on `settings` itself (see `S3Settings`'s
        // doc comment) — it's fetched from the OS keychain here, the one
        // place that actually needs the real value.
        let secret_access_key = crate::settings::s3_secret_access_key().unwrap_or_default();
        let credentials = Credentials::new(
            Some(&settings.access_key_id),
            Some(&secret_access_key),
            None,
            None,
            None,
        )
        .map_err(|e| e.to_string())?;
        Self::with_credentials(settings, credentials, region, image_cache)
    }

    fn with_credentials(
        settings: &S3Settings,
        credentials: Credentials,
        region: Region,
        image_cache: PathBuf,
    ) -> Result<Self, String> {
        let bucket = Bucket::new(&settings.bucket, region, credentials)
            .map_err(|error| error.to_string())?
            .with_path_style()
            .with_request_timeout(Duration::from_secs(10))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            bucket,
            images: ImageAssets::new(image_cache)?,
            prefix: settings.prefix.clone(),
            items_cache: Mutex::new(HashMap::new()),
            history_cache: Mutex::new(HashMap::new()),
            collections_cache: Mutex::new(HashMap::new()),
        })
    }

    fn object_prefix(&self, directory: &str) -> String {
        format!("{}{directory}/", self.prefix)
    }

    fn read_objects<T: serde::de::DeserializeOwned + Clone + Send>(
        &self,
        directory: &str,
        cache: &Mutex<ObjectCache<T>>,
    ) -> Result<Vec<T>, String> {
        let prefix = self.object_prefix(directory);
        let pages = self
            .bucket
            .list(prefix.clone(), None)
            .map_err(|error| error.to_string())?;
        let mut cache = cache.lock().map_err(|error| error.to_string())?;
        let mut present = HashSet::new();
        let mut records = Vec::new();
        let mut changed = Vec::new();
        for object in pages.into_iter().flat_map(|page| page.contents) {
            let Some(id) = object
                .key
                .strip_prefix(&prefix)
                .and_then(|key| key.strip_suffix(".json"))
            else {
                continue;
            };
            if id.is_empty() || id.contains('/') {
                continue;
            }
            present.insert(object.key.clone());
            let etag = object.e_tag.unwrap_or_default();
            if let Some((_, value)) = cache
                .get(&object.key)
                .filter(|(cached_etag, _)| !etag.is_empty() && cached_etag == &etag)
            {
                records.push(value.clone());
                continue;
            }
            changed.push((object.key, etag));
        }
        for batch in changed.chunks(4) {
            let fetched = std::thread::scope(|scope| {
                let workers: Vec<_> = batch
                    .iter()
                    .map(|(key, etag)| {
                        scope.spawn(move || {
                            let response = self
                                .bucket
                                .get_object(key)
                                .map_err(|error| error.to_string())?;
                            check_status(response.status_code())?;
                            let value: T = serde_json::from_slice(response.as_slice())
                                .map_err(|error| error.to_string())?;
                            Ok::<_, String>((key.clone(), etag.clone(), value))
                        })
                    })
                    .collect();
                workers
                    .into_iter()
                    .map(|worker| {
                        worker
                            .join()
                            .map_err(|_| "S3 reader panicked".to_string())?
                    })
                    .collect::<Result<Vec<_>, String>>()
            })?;
            for (key, etag, value) in fetched {
                records.push(value.clone());
                cache.insert(key, (etag, value));
            }
        }
        cache.retain(|key, _| present.contains(key));
        Ok(records)
    }

    fn item_key(&self, id: &str) -> String {
        format!("{}{id}.json", self.object_prefix("items"))
    }

    fn history_key(&self, id: &str) -> String {
        format!("{}{id}.json", self.object_prefix("history"))
    }

    fn collection_key(&self, id: &str) -> String {
        format!("{}{id}.json", self.object_prefix("collections"))
    }

    fn get_item(&self, id: &str) -> Result<Item, String> {
        let response = self
            .bucket
            .get_object(self.item_key(id))
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())?;
        let mut item = serde_json::from_slice(response.as_slice()).map_err(|e| e.to_string())?;
        self.resolve_image(&mut item)?;
        Ok(item)
    }

    fn resolve_image(&self, item: &mut Item) -> Result<(), String> {
        self.images.resolve(item, |identifier| {
            let response = self
                .bucket
                .get_object(format!("{}{identifier}.png", self.object_prefix("assets")))
                .map_err(|error| error.to_string())?;
            check_status(response.status_code())?;
            Ok(response.as_slice().to_vec())
        })
    }

    fn put_item(&self, item: &Item) -> Result<(), String> {
        let encoded = self.images.encode(item, |identifier, bytes| {
            let response = self
                .bucket
                .put_object(
                    format!("{}{identifier}.png", self.object_prefix("assets")),
                    bytes,
                )
                .map_err(|error| error.to_string())?;
            check_status(response.status_code())
        })?;
        let bytes = serde_json::to_vec(&encoded).map_err(|e| e.to_string())?;
        let response = self
            .bucket
            .put_object(self.item_key(&item.id), &bytes)
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())
    }

    fn put_collection(&self, collection: &Collection) -> Result<(), String> {
        let bytes = serde_json::to_vec(collection).map_err(|e| e.to_string())?;
        let response = self
            .bucket
            .put_object(self.collection_key(&collection.id), &bytes)
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())
    }
}

impl Store for S3Store {
    fn list_items(&self) -> Result<Vec<Item>, String> {
        let mut items = self.read_objects("items", &self.items_cache)?;
        for item in &mut items {
            self.resolve_image(item)?;
        }
        items.sort_by(|a, b| {
            b.bookmarked
                .cmp(&a.bookmarked)
                .then(b.rank.total_cmp(&a.rank))
                .then(b.created_at.cmp(&a.created_at))
        });
        let history = self.list_history(u32::MAX)?;
        super::apply_copy_stats(&mut items, &history);
        Ok(items)
    }

    fn list_collections(&self) -> Result<Vec<Collection>, String> {
        let mut collections = self.read_objects("collections", &self.collections_cache)?;
        collections.sort_by(|a, b| {
            b.rank
                .total_cmp(&a.rank)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(collections)
    }

    fn save_collection(&self, collection: Collection) -> Result<(), String> {
        super::validate_collection(&collection)?;
        self.put_collection(&collection)
    }

    fn delete_collection(&self, id: &str) -> Result<(), String> {
        let response = self
            .bucket
            .delete_object(self.collection_key(id))
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())
    }

    fn add_item(
        &self,
        text: &str,
        kind: ItemKind,
        source_app: Option<String>,
    ) -> Result<Item, String> {
        let max_rank = self
            .read_objects("items", &self.items_cache)?
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
        self.put_item(&item)?;
        self.get_item(&item.id)
    }

    fn toggle_done(&self, id: &str) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.done = !item.done;
        self.put_item(&item)
    }

    fn toggle_bookmarked(&self, id: &str) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.bookmarked = !item.bookmarked;
        self.put_item(&item)
    }

    fn set_kind(&self, id: &str, kind: ItemKind) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.kind = kind;
        self.put_item(&item)
    }

    fn set_tags(&self, id: &str, tags: Vec<String>) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.tags = super::normalize_tags(&tags);
        self.put_item(&item)
    }

    fn update_text(&self, id: &str, text: &str) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.text = text.to_string();
        self.put_item(&item)
    }

    fn delete_item(&self, id: &str) -> Result<(), String> {
        let response = self
            .bucket
            .delete_object(self.item_key(id))
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())
    }

    fn clear_completed(&self) -> Result<(), String> {
        for item in self.list_items()?.into_iter().filter(|i| i.done) {
            self.delete_item(&item.id)?;
        }
        Ok(())
    }

    fn move_item(&self, id: &str, direction: MoveDirection) -> Result<(), String> {
        let items = self.list_items()?;
        let Some(new_rank) = compute_move_rank(&items, id, direction) else {
            return Ok(());
        };
        let mut item = self.get_item(id)?;
        item.rank = new_rank;
        self.put_item(&item)
    }

    fn restore_item(&self, item: Item) -> Result<(), String> {
        self.put_item(&item)
    }

    fn set_rank(&self, id: &str, rank: f64) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.rank = rank;
        self.put_item(&item)
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
        let bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        let response = self
            .bucket
            .put_object(self.history_key(&entry.id), &bytes)
            .map_err(|e| e.to_string())?;
        check_status(response.status_code())
    }

    fn list_history(&self, limit: u32) -> Result<Vec<HistoryEntry>, String> {
        let mut entries = self.read_objects("history", &self.history_cache)?;
        entries.sort_by(|a, b| b.at.cmp(&a.at));
        entries.truncate(limit as usize);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires scripts/sync-e2e.sh S3 service"]
    fn s3_sync_e2e() {
        let endpoint = std::env::var("SHIFTSHIFT_TEST_S3_ENDPOINT").expect("S3 test endpoint");
        let settings = S3Settings {
            bucket: "shiftshift-sync-test".into(),
            endpoint: endpoint.clone(),
            region: "us-east-1".into(),
            prefix: format!("e2e/{}/", uuid::Uuid::new_v4()),
            ..Default::default()
        };
        let open = || {
            S3Store::with_credentials(
                &settings,
                Credentials::new(Some("S3RVER"), Some("S3RVER"), None, None, None).unwrap(),
                Region::Custom {
                    region: settings.region.clone(),
                    endpoint: endpoint.clone(),
                },
                std::env::temp_dir().join(format!("shiftshift-s3-cache-{}", uuid::Uuid::new_v4())),
            )
            .unwrap()
        };
        let first = open();
        let second = open();
        super::super::sync_e2e::exercise_sync(&first, &second);
        let reopened = open();
        assert!(reopened.list_items().unwrap().is_empty());
        assert_eq!(reopened.list_history(10).unwrap().len(), 1);
        let missing_settings = S3Settings {
            bucket: "missing-bucket".into(),
            ..settings
        };
        let missing = S3Store::with_credentials(
            &missing_settings,
            Credentials::new(Some("S3RVER"), Some("S3RVER"), None, None, None).unwrap(),
            Region::Custom {
                region: "us-east-1".into(),
                endpoint,
            },
            std::env::temp_dir().join(format!("shiftshift-s3-cache-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        assert!(missing.add_item("must fail", ItemKind::Note, None).is_err());
    }

    #[test]
    fn open_rejects_a_bucket_without_an_endpoint() {
        let settings = S3Settings {
            bucket: "my-bucket".to_string(),
            ..S3Settings::default()
        };
        assert!(S3Store::open(
            &settings,
            std::env::temp_dir().join("shiftshift-invalid-config")
        )
        .is_err());
    }

    #[test]
    fn open_rejects_an_endpoint_without_a_bucket() {
        let settings = S3Settings {
            endpoint: "https://s3.example.com".to_string(),
            ..S3Settings::default()
        };
        assert!(S3Store::open(
            &settings,
            std::env::temp_dir().join("shiftshift-invalid-config")
        )
        .is_err());
    }
}
