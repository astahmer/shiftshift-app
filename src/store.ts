import { invoke } from "@tauri-apps/api/core";

export type ItemKind = "note" | "todo" | "link";

export type Action = "capture" | "toggle_panel" | "none";

export interface Bindings {
	left: Action;
	right: Action;
}

export interface Template {
	id: string;
	name: string;
	body: string;
}

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

	static getBindings(): Promise<Bindings> {
		return invoke("get_bindings");
	}

	static setBindings(bindings: Bindings): Promise<void> {
		return invoke("set_bindings", { bindings });
	}

	static exportMarkdown(): Promise<string> {
		return invoke("export_markdown");
	}

	static listTemplates(): Promise<Template[]> {
		return invoke("list_templates");
	}

	static addTemplate(name: string, body: string): Promise<Template> {
		return invoke("add_template", { name, body });
	}

	static updateTemplate(id: string, name: string, body: string): Promise<void> {
		return invoke("update_template", { id, name, body });
	}

	static deleteTemplate(id: string): Promise<void> {
		return invoke("delete_template", { id });
	}
}
