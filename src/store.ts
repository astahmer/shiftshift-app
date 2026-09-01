import { invoke } from "@tauri-apps/api/core";

export type ItemKind = "note" | "todo" | "link" | "image";

export type Action = "capture" | "toggle_panel" | "none";

export type CaptureMode = "silent" | "open" | "draft";

/** Enter on a highlighted row: copy only, copy+hide, or copy+hide+paste into the previous app. */
export type HighlightSubmit = "copy" | "copy_hide" | "copy_hide_write";

export type NotificationStyle = "none" | "native" | "custom";

/** What text a notification shows — applies to both "native" and "custom" styles. See notify.rs's `NotifyContent` doc comment for native's icon_only caveat. */
export type NotifyContent = "icon_only" | "icon_title" | "icon_title_excerpt" | "icon_excerpt";

/** Where the "custom" toast sits on screen — a 3x3 grid of presets, plus a user-dragged `custom` position. */
export type ToastPosition =
	| "top_left"
	| "top_center"
	| "top_right"
	| "middle_left"
	| "left_top"
	| "left_upper"
	| "left_lower"
	| "left_bottom"
	| "right_top"
	| "right_upper"
	| "right_lower"
	| "right_bottom"
	| "top_mid_left"
	| "top_mid_right"
	| "bottom_mid_left"
	| "bottom_mid_right"
	| "center"
	| "middle_right"
	| "bottom_left"
	| "bottom_center"
	| "bottom_right"
	| "custom";

/** The file stems under /System/Library/Sounds on macOS — see notify.rs's `play_sound`. */
export const SYSTEM_SOUNDS: string[] = [
	"Basso",
	"Blow",
	"Bottle",
	"Frog",
	"Funk",
	"Glass",
	"Hero",
	"Morse",
	"Ping",
	"Pop",
	"Purr",
	"Sosumi",
	"Submarine",
	"Tink",
];

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
	notification_style: NotificationStyle;
	notify_sound: boolean;
	notify_sound_name: string;
	/** 0-100. */
	notify_sound_volume: number;
	notify_content: NotifyContent;
	toast_position: ToastPosition;
	/** Physical screen coordinates of the toast window's top-left corner; only meaningful when `toast_position === "custom"`. */
	toast_custom_x: number;
	toast_custom_y: number;
	/** Milliseconds the toast stays up before auto-hiding — "custom" style only. */
	toast_duration_ms: number;
	/** Percent scale (100 = normal) applied to the toast's text/icon — "custom" style only. */
	toast_font_scale: number;
	/** Off by default — a small always-visible pill of recent captures, see Settings -> Dock and src/dock.ts. */
	dock_enabled: boolean;
	dock_position: ToastPosition;
	dock_custom_x: number;
	dock_custom_y: number;
	/** How many recent items the expanded dock shows. */
	dock_item_count: number;
	/** Logical pixel height of one expanded row. `0` means the compiled default. */
	dock_row_height: number;
	/** Expanded notch size in logical pixels. `0` means the compiled default. */
	dock_expanded_width: number;
	dock_expanded_height: number;
	fallback_toggle: string;
	fallback_capture: string;
	fallback_image: string;
	capture_mode: CaptureMode;
	/** Enter on a highlighted row — default is copy + hide + paste into wherever focus was. */
	highlight_submit: HighlightSubmit;
	hide_on_blur: boolean;
	/** macOS inline autocorrect on the capture input. Off by default. */
	input_spellcheck: boolean;
	clipboard_watch: boolean;
	launch_at_login: boolean;
	backend: "local" | "s3" | "folder";
	s3: S3Settings;
	sort_mode: SortMode;
	show_in_dock: boolean;
	show_tray_icon: boolean;
	folder_path: string;
	/** Overrides the active theme's own background opacity when > 0; 0 means "use the theme's default". */
	panel_opacity: number;
	/** App names clipboard-watch never auto-captures from (case-insensitive substring match) — password managers by default. */
	excluded_apps: string[];
	/** Encrypts the local SQLite store at rest (SQLCipher). Restart required to take effect. */
	encrypt_local_storage: boolean;
	/** Item ids pinned to ⌘1-⌘9 (index 0 = slot 1); always 9 entries, "" means unassigned. */
	pinned_items: string[];
	/** Remembered panel frame. `panel_width === 0` means the compiled default; `panel_placed` is false until the user has resized or dragged once. */
	panel_width: number;
	panel_height: number;
	panel_x: number;
	panel_y: number;
	panel_placed: boolean;
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

/** Palette a custom theme can set. The original 7 roles are required; the rest fall back to those when empty. Alphas are 0–100. */
export interface ThemeColors {
	bg: string;
	fg: string;
	muted: string;
	row_bg: string;
	accent: string;
	accent_fg: string;
	border: string;
	bg_alpha: number;
	row_alpha: number;
	input_bg: string;
	input_fg: string;
	input_border: string;
	button_bg: string;
	button_fg: string;
	selected_bg: string;
	hover_bg: string;
	danger: string;
	meta: string;
	radius: number;
	radius_sm: number;
	font_family: string;
	font_size: number;
	font_weight: number;
	border_width: number;
	backdrop_blur: number;
	press_offset: number;
	gap: number;
	pad: number;
	window_radius: number;
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

export interface SyncStatus {
	active_backend: "local" | "s3" | "folder";
	configured_backend: "local" | "s3" | "folder";
	fallback_reason: string | null;
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

	/** Native OS drag — notes into text fields, images into file dropzones. */
	static startItemDrag(kind: ItemKind, text: string): Promise<void> {
		return invoke("start_item_drag", { kind, text });
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

	static captureClipboardImage(): Promise<Item> {
		return invoke("capture_clipboard_image");
	}

	static copyImageToClipboard(path: string): Promise<void> {
		return invoke("copy_image_to_clipboard", { path });
	}

	static fetchLinkPreview(url: string): Promise<LinkPreview> {
		return invoke("fetch_link_preview", { url });
	}

	/** Whether the double-Shift hook can actually run right now — always `true` on non-mac. */
	static accessibilityTrusted(): Promise<boolean> {
		return invoke("accessibility_trusted");
	}

	static openAccessibilitySettings(): Promise<void> {
		return invoke("open_accessibility_settings");
	}

	/** Reveals a file in Finder — used for "Share" on image items, since Finder's own Share button has full AirDrop/Mail/Messages access that a spawned process doesn't. */
	static revealInFinder(path: string): Promise<void> {
		return invoke("reveal_in_finder", { path });
	}

	/** Opens a captured image in the system viewer (Preview.app on macOS). */
	static previewFile(path: string): Promise<void> {
		return invoke("preview_file", { path });
	}

	static getSyncStatus(): Promise<SyncStatus> {
		return invoke("get_sync_status");
	}

	static getSettings(): Promise<Settings> {
		return invoke("get_settings");
	}

	/** The only way to hide the panel — restores focus to whatever app was frontmost before it was summoned. See panel.rs. */
	static hidePanel(): Promise<void> {
		return invoke("hide_panel");
	}

	/** Raise the main panel (e.g. `/settings` from the notch). */
	static showPanel(): Promise<void> {
		return invoke("show_panel");
	}

	static savePanelFrame(width: number, height: number, x: number, y: number): Promise<void> {
		return invoke("save_panel_frame", { width, height, x, y });
	}

	/** Hide, restore previous-app focus, then paste. Default highlighted-item Enter. */
	static hidePanelAndPaste(): Promise<void> {
		return invoke("hide_panel_and_paste");
	}

	/** The `s3.secret_access_key` field is write-only — see settings.rs's `S3Settings` doc comment. A non-empty value here is stored to the OS keychain and never round-trips back; leave it empty to keep whatever's already set. */
	static setSettings(settings: Settings): Promise<void> {
		return invoke("set_settings", { next: settings });
	}

	static resetSettings(): Promise<Settings> {
		return invoke("reset_settings");
	}

	/** Whether an S3 secret access key is already stored in the keychain — for showing "(unchanged)" instead of a blank field looking unset. */
	static s3SecretConfigured(): Promise<boolean> {
		return invoke("s3_secret_configured");
	}

	static clearS3Secret(): Promise<void> {
		return invoke("clear_s3_secret");
	}

	/** Auditions a sound/volume combo without touching saved settings. */
	static previewSound(name: string, volume: number): Promise<void> {
		return invoke("preview_sound", { name, volume });
	}

	/** Shows the toast at a candidate position without saving it — see Settings -> Notifications. */
	static previewToastPosition(position: ToastPosition, customX: number, customY: number): Promise<void> {
		return invoke("preview_toast_position", { position, customX, customY });
	}

	static previewNotification(): Promise<void> {
		return invoke("preview_notification");
	}

	/** Shows a persistent, draggable sample toast the user can drop anywhere on screen. */
	static startToastArrange(): Promise<void> {
		return invoke("start_toast_arrange");
	}

	/** Reads back wherever the toast was dropped, snaps/persists the result, and hides it. */
	static finishToastArrange(): Promise<void> {
		return invoke("finish_toast_arrange");
	}

	/** Toast webview boot — replay a reveal that fired before the listener attached. */
	static toastReady(): Promise<void> {
		return invoke("toast_ready");
	}

	/** Resizes/repositions the dock window to match — see Settings -> Dock and src/dock.ts. */
	static dockSetExpanded(expanded: boolean): Promise<void> {
		return invoke("dock_set_expanded", { expanded });
	}

	static startDockArrange(): Promise<void> {
		return invoke("start_dock_arrange");
	}

	static prepareDockDrag(): Promise<void> {
		return invoke("prepare_dock_drag");
	}

	static finishDockArrange(): Promise<void> {
		return invoke("finish_dock_arrange");
	}

	static beginDockResize(): Promise<void> {
		return invoke("begin_dock_resize");
	}

	static finishDockResize(): Promise<void> {
		return invoke("finish_dock_resize");
	}

	static saveDockFrame(width: number, height: number): Promise<void> {
		return invoke("save_dock_frame", { width, height });
	}

	static setDockComposer(active: boolean): Promise<void> {
		return invoke("dock_set_composer", { active });
	}

	/** Collapse the notch, restore the previous app, optionally paste. */
	static dockHideAndSubmit(paste: boolean): Promise<void> {
		return invoke("dock_hide_and_submit", { paste });
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

	static replaceCustomThemes(themes: CustomTheme[]): Promise<void> {
		return invoke("replace_custom_themes", { next: themes });
	}
}
