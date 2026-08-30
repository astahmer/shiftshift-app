import { invoke } from "@tauri-apps/api/core";
import type { ThemeId } from "./themes";

export type ItemKind = "note" | "todo" | "link";

export type Action = "capture" | "toggle_panel" | "none";

export interface Bindings {
	left: Action;
	right: Action;
}

export interface Settings {
	bindings: Bindings;
	theme: ThemeId;
	notify_on_save: boolean;
	notify_sound: boolean;
	fallback_toggle: string;
	fallback_capture: string;
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
	bookmarked: boolean;
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

	static toggleBookmarked(id: string): Promise<void> {
		return invoke("toggle_bookmarked", { id });
	}

	static setKind(id: string, kind: ItemKind): Promise<void> {
		return invoke("set_kind", { id, kind });
	}

	static updateItemText(id: string, text: string): Promise<void> {
		return invoke("update_item_text", { id, text });
	}

	static deleteItem(id: string): Promise<void> {
		return invoke("delete_item", { id });
	}

	static clearCompleted(): Promise<void> {
		return invoke("clear_completed");
	}

	static getSettings(): Promise<Settings> {
		return invoke("get_settings");
	}

	static setSettings(settings: Settings): Promise<void> {
		return invoke("set_settings", { next: settings });
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
