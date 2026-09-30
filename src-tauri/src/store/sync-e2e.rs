use super::{Collection, ItemKind, Store};

pub(super) fn exercise_sync(first: &dyn Store, second: &dyn Store) {
    let item = first.add_item("shared task", ItemKind::Todo, None).unwrap();
    assert!(second
        .list_items()
        .unwrap()
        .iter()
        .any(|record| record.id == item.id));
    first.set_tags(&item.id, vec!["work".into()]).unwrap();
    first.update_text(&item.id, "updated task").unwrap();
    first.toggle_bookmarked(&item.id).unwrap();
    first.set_rank(&item.id, 42.0).unwrap();
    first.log_event(Some(&item.id), "used", None).unwrap();
    let records = second.list_items().unwrap();
    let snapshot = records
        .iter()
        .find(|record| record.id == item.id)
        .unwrap()
        .clone();
    assert_eq!(snapshot.text, "updated task");
    assert_eq!(snapshot.tags, vec!["work"]);
    assert!(snapshot.bookmarked);
    assert_eq!(snapshot.rank, 42.0);
    assert_eq!(snapshot.copy_count, 1);
    assert_eq!(second.list_history(1).unwrap().len(), 1);
    second.toggle_done(&item.id).unwrap();
    assert!(
        first
            .list_items()
            .unwrap()
            .iter()
            .find(|record| record.id == item.id)
            .unwrap()
            .done
    );
    let collection = Collection {
        id: "sync-test".into(),
        name: "Shared collection".into(),
        query: Default::default(),
        sort: "manual".into(),
        rank: 1.0,
        icon: None,
        color: None,
        created_at: "2026-09-30T00:00:00Z".into(),
        updated_at: "2026-09-30T00:00:00Z".into(),
    };
    first.save_collection(collection.clone()).unwrap();
    assert_eq!(second.list_collections().unwrap(), vec![collection.clone()]);
    let mut updated = collection;
    updated.name = "Changed remotely".into();
    second.save_collection(updated.clone()).unwrap();
    assert_eq!(first.list_collections().unwrap(), vec![updated]);
    first.delete_collection("sync-test").unwrap();
    assert!(second.list_collections().unwrap().is_empty());
    second.clear_completed().unwrap();
    assert!(!first
        .list_items()
        .unwrap()
        .iter()
        .any(|record| record.id == item.id));
    first.restore_item(snapshot).unwrap();
    assert_eq!(
        second
            .list_items()
            .unwrap()
            .iter()
            .find(|record| record.id == item.id)
            .unwrap()
            .text,
        "updated task"
    );
    let image_directory =
        std::env::temp_dir().join(format!("shiftshift-image-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&image_directory).unwrap();
    let image_path = image_directory.join("source.png");
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[12, 34, 56, 255])
            .unwrap();
    }
    std::fs::write(&image_path, &bytes).unwrap();
    let image = first
        .add_item(image_path.to_str().unwrap(), ItemKind::Image, None)
        .unwrap();
    std::fs::remove_dir_all(image_directory).unwrap();
    let remote_image = second
        .list_items()
        .unwrap()
        .into_iter()
        .find(|record| record.id == image.id)
        .unwrap();
    assert_ne!(remote_image.text, image.text);
    assert_eq!(std::fs::read(&remote_image.text).unwrap(), bytes);
    second.toggle_bookmarked(&image.id).unwrap();
    let updated_image = first
        .list_items()
        .unwrap()
        .into_iter()
        .find(|record| record.id == image.id)
        .unwrap();
    assert!(updated_image.bookmarked);
    assert_eq!(std::fs::read(&updated_image.text).unwrap(), bytes);
    first.delete_item(&image.id).unwrap();
    second.restore_item(remote_image).unwrap();
    assert_eq!(
        std::fs::read(
            &first
                .list_items()
                .unwrap()
                .into_iter()
                .find(|record| record.id == image.id)
                .unwrap()
                .text
        )
        .unwrap(),
        bytes
    );
    first.delete_item(&image.id).unwrap();
    first.delete_item(&item.id).unwrap();
    assert!(!second
        .list_items()
        .unwrap()
        .iter()
        .any(|record| record.id == item.id));
}

#[test]
fn folder_sync_e2e() {
    let root = std::env::temp_dir().join(format!("shiftshift-sync-e2e-{}", uuid::Uuid::new_v4()));
    let first = super::FolderStore::open(root.to_str().unwrap()).unwrap();
    let second = super::FolderStore::open(root.to_str().unwrap()).unwrap();
    exercise_sync(&first, &second);
    drop(first);
    drop(second);
    let reopened = super::FolderStore::open(root.to_str().unwrap()).unwrap();
    assert!(reopened.list_items().unwrap().is_empty());
    assert_eq!(reopened.list_history(10).unwrap().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
