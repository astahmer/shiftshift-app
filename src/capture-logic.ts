import type { Item, SortMode, Template, ThemeColors } from "./store";

const TODO_PREFIX = "/todo ";

export function detectKind(text: string): Item["kind"] {
	if (/^https?:\/\/\S+$/.test(text.trim())) return "link";
	return "note";
}

/** Substitutes `{{name}}` placeholders positionally, in first-appearance order; a repeated name reuses the same arg. */
export function expandTemplate(body: string, args: string[]): string {
	const seen: string[] = [];
	return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name: string) => {
		let index = seen.indexOf(name);
		if (index === -1) {
			seen.push(name);
			index = seen.length - 1;
		}
		return args[index] ?? "";
	});
}

export interface ResolvedCapture {
	text: string;
	kind: Item["kind"];
}

/**
 * Turns what the user typed into what should actually be saved: the
 * built-in `/todo ` prefix, a `/name arg1 arg2` snippet expansion, or the
 * raw text unchanged. `templates` should only be fetched when `raw` starts
 * with "/" — callers decide that to avoid a needless RPC round-trip.
 */
export function resolveCapture(raw: string, templates: Template[]): ResolvedCapture {
	if (raw.startsWith(TODO_PREFIX)) {
		return { text: raw.slice(TODO_PREFIX.length), kind: "todo" };
	}
	if (raw.startsWith("/")) {
		const [name, ...args] = raw.slice(1).split(/\s+/);
		const template = templates.find((t) => t.name === name);
		if (template) {
			const text = expandTemplate(template.body, args);
			return { text, kind: detectKind(text) };
		}
	}
	return { text: raw, kind: detectKind(raw) };
}

export type UiCommand = { type: "open-settings" };

/**
 * UI-level slash commands that don't create an item — checked before
 * `resolveCapture` so "/settings" etc. never fall through to being saved as
 * a literal note. Theme/sort/history have their own dedicated suggestion
 * modes (see `parseSlashMode`) with their own commit path, so they're not
 * handled here anymore.
 */
export function parseUiCommand(raw: string): UiCommand | null {
	const trimmed = raw.trim();
	if (trimmed === "/settings") return { type: "open-settings" };
	return null;
}

/** Enter on a highlighted slash row — settings has no args, so run it. */
export function slashSuggestionIsImmediate(name: string): boolean {
	return name === "settings";
}

/** Case-insensitive exact-text match against existing items — used for the non-blocking duplicate warning. */
export function findDuplicate(items: Item[], text: string): Item | null {
	const needle = text.trim().toLowerCase();
	if (!needle) return null;
	return items.find((item) => item.text.trim().toLowerCase() === needle) ?? null;
}

const TAG_PREDICATES: Record<string, (item: Item) => boolean> = {
	bookmark: (item) => item.bookmarked,
	bookmarks: (item) => item.bookmarked,
	link: (item) => item.kind === "link",
	links: (item) => item.kind === "link",
	todo: (item) => item.kind === "todo",
	todos: (item) => item.kind === "todo",
	note: (item) => item.kind === "note",
	notes: (item) => item.kind === "note",
	image: (item) => item.kind === "image",
	images: (item) => item.kind === "image",
};

function tagPredicate(token: string): ((item: Item) => boolean) | null {
	if (token.startsWith("@")) return TAG_PREDICATES[token.slice(1).toLowerCase()] ?? null;
	if (token.startsWith("has:")) return TAG_PREDICATES[token.slice(4).toLowerCase()] ?? null;
	return null;
}

export type ListTab = "recent" | "bookmarked" | "images" | "todos";

export const LIST_TABS: Array<{ id: ListTab; label: string }> = [
	{ id: "recent", label: "Recent" },
	{ id: "bookmarked", label: "Bookmarked" },
	{ id: "images", label: "Images" },
	{ id: "todos", label: "TODOs" },
];

export function itemsForTab(items: Item[], tab: ListTab): Item[] {
	if (tab === "bookmarked") return items.filter((item) => item.bookmarked);
	if (tab === "images") return items.filter((item) => item.kind === "image");
	if (tab === "todos") return items.filter((item) => item.kind === "todo");
	return items;
}

export function nextListTab(current: ListTab, delta: number): ListTab {
	const index = LIST_TABS.findIndex((tab) => tab.id === current);
	return LIST_TABS[(index + delta + LIST_TABS.length) % LIST_TABS.length]!.id;
}

export function emptyTabCopy(tab: ListTab, hasFilter: boolean): { title: string; body: string } {
	if (hasFilter) return { title: "No matches", body: "Clear the filter or try another @tag / #tag." };
	if (tab === "bookmarked") return { title: "No bookmarks", body: "Bookmark something and it shows up here." };
	if (tab === "images") return { title: "No images", body: "Captured screenshots and pictures wait here." };
	if (tab === "todos") return { title: "No TODOs", body: "Turn a note into a todo and it lands here." };
	return { title: "Nothing captured yet", body: "An answer, a link, a half-formed prompt. It all waits here." };
}

/**
 * Filters the item list as the user types. Supports tag tokens (`@bookmarks`,
 * `@links`, `@todos`, `@notes`, or the equivalent `has:x` form) combined with
 * a plain-text substring match on the remaining words — e.g. `@todos ship`.
 */
export function filterItems(items: Item[], query: string): Item[] {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	const predicates: Array<(item: Item) => boolean> = [];
	const textWords: string[] = [];
	for (const token of tokens) {
		const predicate = tagPredicate(token);
		if (predicate) predicates.push(predicate);
		else textWords.push(token);
	}
	const text = textWords.join(" ").toLowerCase();
	return items.filter((item) => {
		if (!predicates.every((matches) => matches(item))) return false;
		return !text || item.text.toLowerCase().includes(text);
	});
}

const SORT_COMPARATORS: Record<Exclude<SortMode, "manual">, (a: Item, b: Item) => number> = {
	newest: (a, b) => b.created_at.localeCompare(a.created_at),
	oldest: (a, b) => a.created_at.localeCompare(b.created_at),
	az: (a, b) => a.text.localeCompare(b.text),
	za: (a, b) => b.text.localeCompare(a.text),
};

/**
 * Re-orders an already-filtered item list per `/sort`. "manual" is a no-op
 * (the backend's rank-based order is already "manual"); every other mode
 * still keeps bookmarked items pinned above unbookmarked ones, matching the
 * pin behavior everywhere else in the app — only the order *within* each of
 * those two groups changes.
 */
export function applySort(items: Item[], mode: SortMode): Item[] {
	if (mode === "manual") return items;
	const compare = SORT_COMPARATORS[mode];
	return [...items].sort((a, b) => (b.bookmarked === a.bookmarked ? compare(a, b) : Number(b.bookmarked) - Number(a.bookmarked)));
}

export const SORT_OPTIONS: Array<{ mode: SortMode; label: string }> = [
	{ mode: "manual", label: "Manual order" },
	{ mode: "newest", label: "Newest first" },
	{ mode: "oldest", label: "Oldest first" },
	{ mode: "az", label: "Name A → Z" },
	{ mode: "za", label: "Name Z → A" },
];

/** What `/sort <query>` narrows down to, filtered by label prefix or substring. */
export function matchSortSuggestions(query: string): Array<{ mode: SortMode; label: string }> {
	const q = query.trim().toLowerCase();
	if (!q) return SORT_OPTIONS;
	return SORT_OPTIONS.filter((o) => o.mode.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
}

export const BUILTIN_COMMANDS: Array<{ name: string; hint: string }> = [
	{ name: "todo", hint: "Save as a todo" },
	{ name: "settings", hint: "Open settings" },
	{ name: "light", hint: "Switch to a light theme" },
	{ name: "dark", hint: "Switch to a dark theme" },
	{ name: "theme", hint: "Switch to a specific theme" },
	{ name: "sort", hint: "Change list ordering" },
	{ name: "history", hint: "Show capture history" },
	{ name: "help", hint: "Show keyboard shortcuts" },
];

export interface SlashSuggestion {
	name: string;
	hint: string;
	kind: "builtin" | "template";
}

/**
 * What `/`-prefixed input could complete to, filtered by the first word
 * typed so far. Trailing args (e.g. "/standup shipped it") don't narrow the
 * match further — there's only one "standup", args or not.
 */
export function matchSlashSuggestions(query: string, templates: Template[]): SlashSuggestion[] {
	const prefix = (query.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
	const builtins: SlashSuggestion[] = BUILTIN_COMMANDS.map((c) => ({ ...c, kind: "builtin" }));
	const fromTemplates: SlashSuggestion[] = templates.map((t) => ({ name: t.name, hint: t.body, kind: "template" }));
	return [...builtins, ...fromTemplates].filter((s) => s.name.toLowerCase().startsWith(prefix));
}

export type SlashMode =
	| { type: "commands" }
	| { type: "theme"; query: string }
	| { type: "light" }
	| { type: "dark" }
	| { type: "sort"; query: string }
	| { type: "history"; query: string }
	| { type: "help" };

/**
 * Which dedicated suggestion view `/`-prefixed input has committed to. Only
 * matches once the command name is a whole word (`/theme` or `/theme foo`,
 * not `/th`) — before that boundary, `/th` should still fuzzy-match against
 * the generic command list (so it can suggest "theme" itself).
 */
export function parseSlashMode(raw: string): SlashMode {
	const themeMatch = /^\/theme(?:\s+(.*))?$/.exec(raw);
	if (themeMatch) return { type: "theme", query: themeMatch[1] ?? "" };
	if (/^\/light(?:\s|$)/.test(raw)) return { type: "light" };
	if (/^\/dark(?:\s|$)/.test(raw)) return { type: "dark" };
	const sortMatch = /^\/sort(?:\s+(.*))?$/.exec(raw);
	if (sortMatch) return { type: "sort", query: sortMatch[1] ?? "" };
	const historyMatch = /^\/history(?:\s+(.*))?$/.exec(raw);
	if (historyMatch) return { type: "history", query: historyMatch[1] ?? "" };
	if (/^\/help(?:\s|$)/.test(raw)) return { type: "help" };
	return { type: "commands" };
}

export const HELP_SHORTCUTS: Array<{ category: string; shortcut: string; description: string }> = [
	{ category: "Capture", shortcut: "double-tap Shift", description: "Capture the current selection" },
	{ category: "Capture", shortcut: "⌘Enter", description: "Force-save typed text and stay open (does not copy)" },
	{ category: "Capture", shortcut: "⇧Enter", description: "Force-save typed text, copy it, and stay open" },
	{ category: "Capture", shortcut: "⌘V", description: "Paste a clipboard image as an image item" },
	{ category: "Browse", shortcut: "↑ / ↓", description: "Move selection (wraps at both ends)" },
	{ category: "Browse", shortcut: "Enter", description: "Copy/open the selected item and close" },
	{ category: "Browse", shortcut: "Tab", description: "Complete the highlighted item or suggestion; empty Tab switches list tabs" },
	{ category: "Browse", shortcut: "⌘C", description: "Copy the selection (newline-joined) without closing" },
	{ category: "Browse", shortcut: "Shift+→", description: "Open the full detail view" },
	{ category: "Browse", shortcut: "⌥-click", description: "Open image in Preview" },
	{ category: "Organize", shortcut: "⌘B", description: "Toggle bookmark" },
	{ category: "Organize", shortcut: "⌘T", description: "Toggle todo/note" },
	{ category: "Organize", shortcut: "⌘E", description: "Edit inline" },
	{ category: "Organize", shortcut: "⌥↑ / ⌥↓", description: "Reorder (unfiltered view only)" },
	{ category: "Organize", shortcut: "⌘⌫", description: "Delete" },
	{ category: "Organize", shortcut: "⌘Z / ⌘⇧Z", description: "Undo / redo" },
	{ category: "Multi-select", shortcut: "Shift+↑ / Shift+↓", description: "Extend or shrink a contiguous range" },
	{ category: "Multi-select", shortcut: "⌃Space", description: "Toggle the highlighted row in or out, without moving" },
	{ category: "Multi-select", shortcut: "⇧-click", description: "Toggle a row in or out of the selection" },
	{ category: "Multi-select", shortcut: "Enter", description: "Copy selection as a numbered list" },
	{ category: "Multi-select", shortcut: "⌘⌫ / ⌘B / ⌘T", description: "Bulk delete / bookmark / todo-toggle" },
	{ category: "Pins", shortcut: "⌘1-⌘9", description: "Copy the item pinned to that slot" },
	{ category: "Pins", shortcut: "⌘⇧1-⌘⇧9", description: "Pin the selected item to that slot" },
	{ category: "Filters", shortcut: "@tag", description: "Filter by @bookmarks/@links/@todos/@notes" },
	{ category: "Filters", shortcut: "#tag", description: "Filter/tag by hashtag" },
	{ category: "Commands", shortcut: "/theme, /sort, /history, /todo", description: "Type / to see all commands" },
];

export interface ThemeChoice {
	id: string;
	label: string;
	mode: "light" | "dark";
}

/** What `/theme <query>` (or `/light`, `/dark` filtered to one mode) narrows down to — built-in and custom themes merged by the caller. */
export function matchThemeSuggestions(query: string, themes: ThemeChoice[], filterMode?: "light" | "dark"): ThemeChoice[] {
	const q = query.trim().toLowerCase();
	const compact = q.replace(/[\s_-]+/g, "");
	return themes.filter((t) => {
		if (filterMode && t.mode !== filterMode) return false;
		if (!q) return true;
		return (
			t.label.toLowerCase().includes(q) ||
			t.id.toLowerCase().includes(q) ||
			t.label.toLowerCase().replace(/[\s_-]+/g, "").includes(compact)
		);
	});
}

export const FILTER_TAGS: Array<{ tag: string; hint: string }> = [
	{ tag: "bookmarks", hint: "Only bookmarked items" },
	{ tag: "links", hint: "Only links" },
	{ tag: "todos", hint: "Only todos" },
	{ tag: "notes", hint: "Only notes" },
	{ tag: "images", hint: "Only images" },
];

/**
 * Shift+↑/↓ range: the selection is the inclusive span between a sticky
 * anchor and the moving cursor. Walking back toward the anchor drops items;
 * walking away adds them. Replaces any previous selection.
 */
export function extendRangeByIds(
	orderedIds: string[],
	anchorId: string | null,
	cursorId: string | null,
	delta: number,
): { selectedIds: string[]; anchorId: string; cursorId: string } | null {
	if (orderedIds.length === 0) return null;
	let cursor = cursorId ? orderedIds.indexOf(cursorId) : -1;
	if (cursor < 0) cursor = 0;
	let anchor = anchorId ? orderedIds.indexOf(anchorId) : -1;
	if (anchor < 0) anchor = cursor;
	const nextCursor = Math.min(Math.max(cursor + delta, 0), orderedIds.length - 1);
	const start = Math.min(anchor, nextCursor);
	const end = Math.max(anchor, nextCursor);
	return {
		selectedIds: orderedIds.slice(start, end + 1),
		anchorId: orderedIds[anchor]!,
		cursorId: orderedIds[nextCursor]!,
	};
}

/** Completes the in-progress `@` / `#` token (the last word) and leaves a trailing space. */
export function replaceLastToken(raw: string, next: string): string {
	const tokens = raw.split(/\s+/);
	tokens[tokens.length - 1] = next;
	return `${tokens.join(" ")} `;
}

/** The last whitespace-separated token in `raw`, empty if it ends in whitespace (or is empty). */
export function lastToken(raw: string): string {
	const parts = raw.split(/\s+/);
	return parts[parts.length - 1] ?? "";
}

/** What an in-progress `@partial` token could complete to. */
export function matchAtSuggestions(partial: string): Array<{ tag: string; hint: string }> {
	const q = partial.replace(/^@/, "").toLowerCase();
	return FILTER_TAGS.filter((t) => t.tag.startsWith(q));
}

const RELATIVE_TIME_STEPS: Array<[number, string]> = [
	[60, "s"],
	[60, "m"],
	[24, "h"],
	[7, "d"],
	[4.348, "w"],
];

/** A short, subtle relative-time label ("5m", "2h", "3d") — falls back to a locale date past ~4 weeks. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	let diff = Math.max(0, (now - then) / 1000);
	if (diff < 5) return "just now";
	for (const [divisor, unit] of RELATIVE_TIME_STEPS) {
		if (diff < divisor) return `${Math.max(1, Math.round(diff))}${unit}`;
		diff /= divisor;
	}
	return new Date(iso).toLocaleDateString();
}

export type MdSegmentType = "text" | "bold" | "italic" | "code" | "tag";
export interface MdSegment {
	type: MdSegmentType;
	text: string;
}

// Hashtags must start with a letter/underscore, not a digit — otherwise
// "fixes #482" or "PR #17" would render as a tag pill, which is a much more
// common pattern in captured notes than an actual `#42`-style hashtag.
const INLINE_MARKDOWN = /\*\*([^*]+)\*\*|`([^`]+)`|(#[A-Za-z_][\w-]*)|\*([^*]+)\*/g;

/**
 * Lightweight inline-only Markdown for item rows: **bold**, *italic*,
 * `code`, and #hashtags — no blocks, no nesting, no links. Just enough to
 * make short snippets, emphasis, and tags readable in a single-line row.
 */
export function parseInlineMarkdown(text: string): MdSegment[] {
	const segments: MdSegment[] = [];
	let lastIndex = 0;
	INLINE_MARKDOWN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE_MARKDOWN.exec(text))) {
		if (match.index > lastIndex) segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
		if (match[1] !== undefined) segments.push({ type: "bold", text: match[1] });
		else if (match[2] !== undefined) segments.push({ type: "code", text: match[2] });
		else if (match[3] !== undefined) segments.push({ type: "tag", text: match[3] });
		else if (match[4] !== undefined) segments.push({ type: "italic", text: match[4] });
		lastIndex = INLINE_MARKDOWN.lastIndex;
	}
	if (lastIndex < text.length) segments.push({ type: "text", text: text.slice(lastIndex) });
	if (segments.length === 0) segments.push({ type: "text", text: "" });
	return segments;
}

const HASHTAG_PATTERN = /#([A-Za-z_][\w-]*)/g;

/** Every distinct #hashtag used across all items, lowercased and sorted — powers `#` suggestions. */
export function extractTags(items: Item[]): string[] {
	const seen = new Set<string>();
	for (const item of items) {
		for (const match of item.text.matchAll(HASHTAG_PATTERN)) {
			seen.add(match[1]!.toLowerCase());
		}
	}
	return [...seen].sort();
}

/** What an in-progress `#partial` token could complete to, from tags already in use. */
export function matchHashSuggestions(partial: string, items: Item[]): string[] {
	const q = partial.replace(/^#/, "").toLowerCase();
	return extractTags(items).filter((t) => t.startsWith(q));
}

const THEME_COLOR_KEYS: Array<keyof ThemeColors> = ["bg", "fg", "muted", "row_bg", "accent", "accent_fg", "border"];

export function isImportableThemeColors(value: unknown): value is ThemeColors {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!THEME_COLOR_KEYS.every((key) => typeof record[key] === "string" && record[key] !== "")) return false;
	return true;
}

/** Fills optional component colors / alphas so older 7-role palettes still apply. */
export function normalizeThemeColors(value: ThemeColors): ThemeColors {
	return {
		bg: value.bg,
		fg: value.fg,
		muted: value.muted,
		row_bg: value.row_bg,
		accent: value.accent,
		accent_fg: value.accent_fg,
		border: value.border,
		bg_alpha: typeof value.bg_alpha === "number" ? value.bg_alpha : 100,
		row_alpha: typeof value.row_alpha === "number" ? value.row_alpha : 100,
		input_bg: value.input_bg ?? "",
		input_fg: value.input_fg ?? "",
		input_border: value.input_border ?? "",
		button_bg: value.button_bg ?? "",
		button_fg: value.button_fg ?? "",
		selected_bg: value.selected_bg ?? "",
		hover_bg: value.hover_bg ?? "",
		danger: value.danger ?? "",
		meta: value.meta ?? "",
		radius: typeof value.radius === "number" ? value.radius : 16,
		window_radius: typeof value.window_radius === "number" ? value.window_radius : typeof value.radius === "number" ? value.radius : 16,
		radius_sm: typeof value.radius_sm === "number" ? value.radius_sm : 10,
		font_family: value.font_family ?? "",
		font_size: typeof value.font_size === "number" ? value.font_size : 14,
		font_weight: typeof value.font_weight === "number" ? value.font_weight : 500,
		border_width: typeof value.border_width === "number" ? value.border_width : 1,
		backdrop_blur: typeof value.backdrop_blur === "number" ? value.backdrop_blur : 0,
		press_offset: typeof value.press_offset === "number" ? value.press_offset : 0,
		gap: typeof value.gap === "number" ? value.gap : 10,
		pad: typeof value.pad === "number" ? value.pad : 12,
	};
}

/** Validates untrusted clipboard JSON before it's handed to the `add_custom_theme` command. */
export function isImportableTheme(value: unknown): value is { name: string; mode: "light" | "dark"; colors: ThemeColors } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name.length === 0) return false;
	if (record.mode !== "light" && record.mode !== "dark") return false;
	if (!isImportableThemeColors(record.colors)) return false;
	(record as { colors: ThemeColors }).colors = normalizeThemeColors(record.colors as ThemeColors);
	return true;
}

/** Related terms so a search like "dock" also surfaces edge / notch / position rows. */
const SETTINGS_SEARCH_ALIASES: Record<string, readonly string[]> = {
	dock: ["dock", "notch", "pill", "edge", "position", "recent", "place", "menubar"],
	notch: ["dock", "notch", "pill", "edge", "position"],
	edge: ["edge", "position", "dock", "toast", "notch", "corner"],
	toast: ["toast", "notify", "notification", "position", "edge", "icon"],
	notify: ["toast", "notify", "notification", "alert", "sound", "icon"],
	alert: ["toast", "notify", "notification", "alert"],
	theme: ["theme", "look", "appearance", "color", "opacity", "palette", "font", "radius", "win95", "vista", "codex", "terminal"],
	look: ["theme", "look", "appearance", "color", "font"],
	capture: ["capture", "save", "silent", "paste", "highlight", "sort", "mode", "spellcheck", "autocorrect"],
	spellcheck: ["spellcheck", "autocorrect", "correct", "bonjour"],
	autocorrect: ["spellcheck", "autocorrect", "correct"],
	pin: ["pin", "pinned", "slot", "shortcut", "quick"],
	key: ["key", "shortcut", "binding", "shift", "tap", "hotkey"],
	shortcut: ["shortcut", "hotkey", "key", "binding", "fallback", "accelerator"],
	sync: ["sync", "s3", "folder", "backup", "encrypt", "cloud"],
	data: ["data", "export", "update", "backup", "import"],
	snippet: ["snippet", "template", "slash", "expand"],
	sound: ["sound", "volume", "notify", "audio"],
	opacity: ["opacity", "theme", "look", "transparency"],
	font: ["font", "typeface", "size", "theme", "look"],
};

/** Expands a settings-search query into the terms that should match a row. */
export function expandSettingsQuery(query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const fromKey = SETTINGS_SEARCH_ALIASES[q];
	if (fromKey) return [...fromKey];
	const fromValue = Object.entries(SETTINGS_SEARCH_ALIASES).find(([, vals]) => vals.includes(q));
	if (fromValue) return [...fromValue[1]];
	return [q];
}

/** True when `text` (row label + optional keywords) matches the expanded query. */
export function settingsSearchMatches(query: string, text: string): boolean {
	const hay = text.toLowerCase();
	return expandSettingsQuery(query).some((term) => hay.includes(term));
}

export function rankForDrop(visible: Array<{ id: string; rank: number }>, dragId: string, toIndex: number): number {
	const fromIndex = visible.findIndex((item) => item.id === dragId);
	const rest = visible.filter((item) => item.id !== dragId);
	let insertAt = toIndex;
	if (fromIndex >= 0 && fromIndex < toIndex) insertAt -= 1;
	insertAt = Math.max(0, Math.min(insertAt, rest.length));
	const above = rest[insertAt - 1];
	const below = rest[insertAt];
	if (!above && below) return below.rank + 1000;
	if (above && !below) return above.rank - 1000;
	if (above && below) return (above.rank + below.rank) / 2;
	return Date.now();
}

export function fileUrlFromPath(path: string): string {
	if (path.startsWith("file:")) return path;
	const abs = path.startsWith("/") ? path : `/${path}`;
	return encodeURI(`file://${abs}`);
}

/** What other apps should receive when an item is dragged out of the list. */
export function itemExternalDragText(item: Item): string {
	if (item.kind === "image") {
		const name = item.text.split("/").pop();
		return name && name.length > 0 ? name : "image.png";
	}
	return item.text;
}

export const LIST_DRAG_THRESHOLD = 8;

export type ListDragState = {
	id: string;
	from: number;
	over: number;
	x: number;
	y: number;
	live: boolean;
};

export type ListDragEvent =
	| { type: "down"; id: string; index: number; x: number; y: number }
	| { type: "move"; x: number; y: number; overIndex: number; leftWindow: boolean }
	| { type: "leave" }
	| { type: "up" };

export type ListDragEffect =
	| { type: "none" }
	| { type: "reorder"; overIndex: number }
	| { type: "external"; id: string }
	| { type: "commit"; id: string; from: number; over: number };

/**
 * In-list reorder vs drag-out. External starts only after the pointer
 * leaves the window — starting earlier steals the gesture and kills rearrange.
 */
export function applyListDrag(state: ListDragState | null, event: ListDragEvent): { state: ListDragState | null; effect: ListDragEffect } {
	if (event.type === "down") {
		return {
			state: { id: event.id, from: event.index, over: event.index, x: event.x, y: event.y, live: false },
			effect: { type: "none" },
		};
	}
	if (!state) return { state: null, effect: { type: "none" } };
	if (event.type === "leave") {
		// Notch / panel edge: the pointer can leave before 8px of travel.
		// WKWebView also fires pointercancel on the way out — treat both as drag-out.
		return { state: null, effect: { type: "external", id: state.id } };
	}
	if (event.type === "up") {
		if (!state.live || state.over === state.from) return { state: null, effect: { type: "none" } };
		return { state: null, effect: { type: "commit", id: state.id, from: state.from, over: state.over } };
	}
	if (event.leftWindow) return { state: null, effect: { type: "external", id: state.id } };
	const moved = Math.hypot(event.x - state.x, event.y - state.y);
	if (!state.live && moved < LIST_DRAG_THRESHOLD) return { state, effect: { type: "none" } };
	return { state: { ...state, live: true, over: event.overIndex }, effect: { type: "reorder", overIndex: event.overIndex } };
}

export function pointerLeftWindow(x: number, y: number, width: number, height: number): boolean {
	return x < 0 || y < 0 || x > width || y > height;
}

/**
 * Unfocused windows (and the non-focusable notch) often swallow the first
 * `pointerdown`. A later move with the button still held is the same grab.
 */
export function listDragNeedsSyntheticDown(state: ListDragState | null, buttons: number): boolean {
	return state === null && buttons === 1;
}

export function listDragRowFromPoint(x: number, y: number): HTMLElement | null {
	return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drag-index]") ?? null;
}

