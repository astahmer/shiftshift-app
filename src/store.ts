import { invoke } from "@tauri-apps/api/core";

export type ItemKind = "note" | "todo" | "link";

export interface Item {
	id: string;
	kind: ItemKind;
	text: string;
	done: boolean;
	pinned: boolean;
	rank: number;
	source_app: string | null;
	created_at: string;
}

/**
 * Thin RPC boundary over the Rust `Store` port (see src-tauri/src/store/mod.rs).
 * The frontend only ever talks to the active backend through these commands —
 * it never knows whether items live in the local SQLite file or a future
 * remote backend.
 */
export class Store {
	static listItems(): Promise<Item[]> {
		return invoke("list_items");
	}

	static addItem(text: string, kind: ItemKind): Promise<Item> {
		return invoke("add_item", { text, kind });
	}

	static toggleDone(id: string): Promise<void> {
		return invoke("toggle_done", { id });
	}

	static togglePinned(id: string): Promise<void> {
		return invoke("toggle_pinned", { id });
	}

	static deleteItem(id: string): Promise<void> {
		return invoke("delete_item", { id });
	}

	static clearCompleted(): Promise<void> {
		return invoke("clear_completed");
	}
}
