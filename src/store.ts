import { invoke } from "@tauri-apps/api/core";

export type ItemKind = "note" | "todo" | "link" | "image";

export type Action = "capture" | "toggle_panel" | "none";

export type CaptureMode = "silent" | "open" | "draft";

export type MoveDirection = "up" | "down";

export type SortMode = "manual" | "newest" | "oldest" | "az" | "za";

export interface Bindings {
	left: Action;
	right: Action;
}

export interface S3Settings {
	endpoint: string;
	bucket: string;
	region: string;
	access_key_id: string;
	secret_access_key: string;
	prefix: string;
}

export interface Settings {
	bindings: Bindings;
	/** A built-in `ThemeId` (see `themes.ts`) or a `CustomTheme.id` — opaque past that to Rust, just persisted verbatim. */
	theme: string;
	notify_on_save: boolean;
	notify_sound: boolean;
	fallback_toggle: string;
	fallback_capture: string;
	fallback_image: string;
	capture_mode: CaptureMode;
	hide_on_blur: boolean;
	clipboard_watch: boolean;
	launch_at_login: boolean;
	backend: "local" | "s3";
	s3: S3Settings;
	sort_mode: SortMode;
	show_in_dock: boolean;
	show_tray_icon: boolean;
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
	/** Derived from history's "used" events — see `store/mod.rs::apply_copy_stats`. */
	copy_count: number;
	first_copied_at: string | null;
	last_copied_at: string | null;
}

export interface HistoryEntry {
	id: string;
	item_id: string | null;
	action: string;
	detail: string | null;
	at: string;
}

/** The 7 CSS custom-property values a theme (built-in or custom) supplies — see `src/style.css`'s `[data-theme]` blocks. */
export interface ThemeColors {
	bg: string;
	fg: string;
	muted: string;
	row_bg: string;
	accent: string;
	accent_fg: string;
	border: string;
}

export interface CustomTheme {
	id: string;
	name: string;
	mode: "light" | "dark";
	colors: ThemeColors;
}

export interface LinkPreview {
	title: string | null;
	favicon: string | null;
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

	static moveItem(id: string, direction: MoveDirection): Promise<void> {
		return invoke("move_item", { id, direction });
	}

	/** Undo side of a delete, redo side of an add — re-inserts a full previously-returned `Item` as-is. */
	static restoreItem(item: Item): Promise<void> {
		return invoke("restore_item", { item });
	}

	/** Undo/redo for `moveItem` — sets an exact rank rather than "one slot up/down". */
	static setRank(id: string, rank: number): Promise<void> {
		return invoke("set_rank", { id, rank });
	}

	static listHistory(limit: number): Promise<HistoryEntry[]> {
		return invoke("list_history", { limit });
	}

	static logUsed(id: string): Promise<void> {
		return invoke("log_used", { id });
	}

	static noteOwnClipboardWrite(text: string): Promise<void> {
		return invoke("note_own_clipboard_write", { text });
	}

	static captureClipboardImage(): Promise<void> {
		return invoke("capture_clipboard_image");
	}

	static copyImageToClipboard(path: string): Promise<void> {
		return invoke("copy_image_to_clipboard", { path });
	}

	static fetchLinkPreview(url: string): Promise<LinkPreview> {
		return invoke("fetch_link_preview", { url });
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

	static listCustomThemes(): Promise<CustomTheme[]> {
		return invoke("list_custom_themes");
	}

	static addCustomTheme(name: string, mode: "light" | "dark", colors: ThemeColors): Promise<CustomTheme> {
		return invoke("add_custom_theme", { name, mode, colors });
	}

	static updateCustomTheme(id: string, name: string, mode: "light" | "dark", colors: ThemeColors): Promise<void> {
		return invoke("update_custom_theme", { id, name, mode, colors });
	}

	static deleteCustomTheme(id: string): Promise<void> {
		return invoke("delete_custom_theme", { id });
	}
}
