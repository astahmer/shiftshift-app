//! Markdown export. Pure formatting over an already-fetched item list, kept
//! separate from the `export_markdown` command so the grouping/formatting
//! rules are unit-testable without a real store or filesystem.

use crate::store::{Item, ItemKind};

pub fn to_markdown(items: &[Item]) -> String {
    let todos: Vec<&Item> = items.iter().filter(|i| i.kind == ItemKind::Todo).collect();
    let notes: Vec<&Item> = items.iter().filter(|i| i.kind == ItemKind::Note).collect();
    let links: Vec<&Item> = items.iter().filter(|i| i.kind == ItemKind::Link).collect();

    let mut out = String::from("# shiftshift export\n\n");
    append_section(&mut out, "Todos", &todos, |item| format!("- [{}] {}", if item.done { "x" } else { " " }, item.text));
    append_section(&mut out, "Notes", &notes, |item| format!("- {}", item.text));
    append_section(&mut out, "Links", &links, |item| format!("- {}", item.text));
    out
}

fn append_section(out: &mut String, title: &str, items: &[&Item], line: impl Fn(&Item) -> String) {
    if items.is_empty() {
        return;
    }
    out.push_str(&format!("## {title}\n\n"));
    for item in items {
        out.push_str(&line(item));
        out.push('\n');
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: ItemKind, text: &str, done: bool) -> Item {
        Item {
            id: "id".into(),
            kind,
            text: text.into(),
            done,
            pinned: false,
            rank: 0.0,
            source_app: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn empty_list_has_no_sections() {
        let md = to_markdown(&[]);
        assert_eq!(md, "# shiftshift export\n\n");
    }

    #[test]
    fn groups_items_by_kind_with_checkboxes_for_todos() {
        let items = vec![
            item(ItemKind::Todo, "buy milk", false),
            item(ItemKind::Todo, "call mom", true),
            item(ItemKind::Note, "idea", false),
            item(ItemKind::Link, "https://example.com", false),
        ];
        let md = to_markdown(&items);
        assert!(md.contains("## Todos\n\n- [ ] buy milk\n- [x] call mom\n"));
        assert!(md.contains("## Notes\n\n- idea\n"));
        assert!(md.contains("## Links\n\n- https://example.com\n"));
    }
}
