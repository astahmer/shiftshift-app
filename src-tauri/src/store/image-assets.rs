use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{Item, ItemKind};

const IMAGE_REFERENCE_PREFIX: &str = "shiftshift-image:";

pub(super) struct ImageAssets {
    directory: PathBuf,
    published: Mutex<HashSet<String>>,
}

impl ImageAssets {
    pub(super) fn new(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(Self {
            directory,
            published: Mutex::new(HashSet::new()),
        })
    }

    fn reference_id(reference: &str) -> Result<Option<String>, String> {
        let Some(identifier) = reference.strip_prefix(IMAGE_REFERENCE_PREFIX) else {
            return Ok(None);
        };
        let identifier = uuid::Uuid::parse_str(identifier).map_err(|error| error.to_string())?;
        Ok(Some(identifier.to_string()))
    }

    fn path(&self, identifier: &str) -> PathBuf {
        self.directory.join(format!("sync-{identifier}.png"))
    }

    pub(super) fn encode(
        &self,
        item: &Item,
        upload: impl FnOnce(&str, &[u8]) -> Result<(), String>,
    ) -> Result<Item, String> {
        let mut encoded = item.clone();
        if item.kind != ItemKind::Image || Self::reference_id(&item.text)?.is_some() {
            return Ok(encoded);
        }
        let path = Path::new(&item.text);
        if path.parent() == Some(self.directory.as_path()) {
            if let Some(identifier) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("sync-"))
                .and_then(|name| name.strip_suffix(".png"))
            {
                let identifier =
                    uuid::Uuid::parse_str(identifier).map_err(|error| error.to_string())?;
                let mut published = self.published.lock().map_err(|error| error.to_string())?;
                if !published.contains(&identifier.to_string()) {
                    upload(
                        &identifier.to_string(),
                        &fs::read(path).map_err(|error| error.to_string())?,
                    )?;
                    published.insert(identifier.to_string());
                }
                encoded.text = format!("{IMAGE_REFERENCE_PREFIX}{identifier}");
                return Ok(encoded);
            }
        }
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        let identifier = uuid::Uuid::new_v4().to_string();
        upload(&identifier, &bytes)?;
        write_bytes(&self.path(&identifier), &bytes)?;
        self.published
            .lock()
            .map_err(|error| error.to_string())?
            .insert(identifier.clone());
        encoded.text = format!("{IMAGE_REFERENCE_PREFIX}{identifier}");
        Ok(encoded)
    }

    pub(super) fn resolve(
        &self,
        item: &mut Item,
        download: impl FnOnce(&str) -> Result<Vec<u8>, String>,
    ) -> Result<(), String> {
        if item.kind != ItemKind::Image {
            return Ok(());
        }
        let Some(identifier) = Self::reference_id(&item.text)? else {
            return Ok(());
        };
        let path = self.path(&identifier);
        if !path.is_file() {
            write_bytes(&path, &download(&identifier)?)?;
        }
        self.published
            .lock()
            .map_err(|error| error.to_string())?
            .insert(identifier);
        item.text = path.to_string_lossy().into_owned();
        Ok(())
    }
}

pub(super) fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_external_image_references_outside_uuid_namespace() {
        assert!(ImageAssets::reference_id("shiftshift-image:../../private.png").is_err());
        assert!(ImageAssets::reference_id("shiftshift-image:invalid").is_err());
        assert_eq!(
            ImageAssets::reference_id("/legacy/image.png").unwrap(),
            None
        );
    }
}
