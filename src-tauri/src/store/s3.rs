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
//! UNVERIFIED AGAINST A REAL BUCKET: the SigV4 signing and HTTP plumbing are
//! `rust-s3`'s, which is a mature, widely-used crate — but this module's own
//! request shapes (list/get/put/delete calls, key layout) have only been
//! checked by reading `rust-s3`'s docs and by compiling, not by running
//! against a live S3-compatible endpoint. Test against a real bucket before
//! relying on it.

use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;

use super::{compute_move_rank, HistoryEntry, Item, ItemKind, MoveDirection, Store};
use crate::settings::S3Settings;

pub struct S3Store {
    bucket: Box<Bucket>,
    prefix: String,
}

impl S3Store {
    pub fn open(settings: &S3Settings) -> Result<Self, String> {
        if settings.bucket.is_empty() || settings.endpoint.is_empty() {
            return Err("S3 settings need at least a bucket and an endpoint".to_string());
        }
        let region = Region::Custom { region: settings.region.clone(), endpoint: settings.endpoint.clone() };
        let credentials = Credentials::new(
            Some(&settings.access_key_id),
            Some(&settings.secret_access_key),
            None,
            None,
            None,
        )
        .map_err(|e| e.to_string())?;
        let bucket = Bucket::new(&settings.bucket, region, credentials).map_err(|e| e.to_string())?;
        Ok(Self { bucket, prefix: settings.prefix.clone() })
    }

    fn item_key(&self, id: &str) -> String {
        format!("{}items/{}.json", self.prefix, id)
    }

    fn history_key(&self, id: &str) -> String {
        format!("{}history/{}.json", self.prefix, id)
    }

    fn get_item(&self, id: &str) -> Result<Item, String> {
        let response = self.bucket.get_object(self.item_key(id)).map_err(|e| e.to_string())?;
        serde_json::from_slice(response.as_slice()).map_err(|e| e.to_string())
    }

    fn put_item(&self, item: &Item) -> Result<(), String> {
        let bytes = serde_json::to_vec(item).map_err(|e| e.to_string())?;
        self.bucket.put_object(self.item_key(&item.id), &bytes).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Store for S3Store {
    fn list_items(&self) -> Result<Vec<Item>, String> {
        let pages = self.bucket.list(format!("{}items/", self.prefix), None).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for page in pages {
            for object in page.contents {
                let response = self.bucket.get_object(&object.key).map_err(|e| e.to_string())?;
                items.push(serde_json::from_slice::<Item>(response.as_slice()).map_err(|e| e.to_string())?);
            }
        }
        items.sort_by(|a, b| {
            b.bookmarked.cmp(&a.bookmarked).then(b.rank.total_cmp(&a.rank)).then(b.created_at.cmp(&a.created_at))
        });
        let history = self.list_history(u32::MAX)?;
        super::apply_copy_stats(&mut items, &history);
        Ok(items)
    }

    fn add_item(&self, text: &str, kind: ItemKind, source_app: Option<String>) -> Result<Item, String> {
        let max_rank = self.list_items()?.iter().map(|i| i.rank).fold(0.0, f64::max);
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
        self.put_item(&item)?;
        Ok(item)
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

    fn update_text(&self, id: &str, text: &str) -> Result<(), String> {
        let mut item = self.get_item(id)?;
        item.text = text.to_string();
        self.put_item(&item)
    }

    fn delete_item(&self, id: &str) -> Result<(), String> {
        self.bucket.delete_object(self.item_key(id)).map_err(|e| e.to_string())?;
        Ok(())
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

    fn log_event(&self, item_id: Option<&str>, action: &str, detail: Option<&str>) -> Result<(), String> {
        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            item_id: item_id.map(|s| s.to_string()),
            action: action.to_string(),
            detail: detail.map(|s| s.to_string()),
            at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        self.bucket.put_object(self.history_key(&entry.id), &bytes).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn list_history(&self, limit: u32) -> Result<Vec<HistoryEntry>, String> {
        let pages = self.bucket.list(format!("{}history/", self.prefix), None).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for page in pages {
            for object in page.contents {
                let response = self.bucket.get_object(&object.key).map_err(|e| e.to_string())?;
                entries.push(serde_json::from_slice::<HistoryEntry>(response.as_slice()).map_err(|e| e.to_string())?);
            }
        }
        entries.sort_by(|a, b| b.at.cmp(&a.at));
        entries.truncate(limit as usize);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_rejects_a_bucket_without_an_endpoint() {
        let settings = S3Settings { bucket: "my-bucket".to_string(), ..S3Settings::default() };
        assert!(S3Store::open(&settings).is_err());
    }

    #[test]
    fn open_rejects_an_endpoint_without_a_bucket() {
        let settings = S3Settings { endpoint: "https://s3.example.com".to_string(), ..S3Settings::default() };
        assert!(S3Store::open(&settings).is_err());
    }
}
