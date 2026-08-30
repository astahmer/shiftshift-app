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
	| { type: "history"; query: string };

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
	return { type: "commands" };
}

export interface ThemeChoice {
	id: string;
	label: string;
	mode: "light" | "dark";
}

/** What `/theme <query>` (or `/light`, `/dark` filtered to one mode) narrows down to — built-in and custom themes merged by the caller. */
export function matchThemeSuggestions(query: string, themes: ThemeChoice[], filterMode?: "light" | "dark"): ThemeChoice[] {
	const q = query.trim().toLowerCase();
	return themes.filter((t) => (!filterMode || t.mode === filterMode) && (!q || t.label.toLowerCase().includes(q)));
}

export const FILTER_TAGS: Array<{ tag: string; hint: string }> = [
	{ tag: "bookmarks", hint: "Only bookmarked items" },
	{ tag: "links", hint: "Only links" },
	{ tag: "todos", hint: "Only todos" },
	{ tag: "notes", hint: "Only notes" },
	{ tag: "images", hint: "Only images" },
];

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

export type MdSegmentType = "text" | "bold" | "italic" | "code";
export interface MdSegment {
	type: MdSegmentType;
	text: string;
}

const INLINE_MARKDOWN = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;

/**
 * Lightweight inline-only Markdown for item rows: **bold**, *italic*,
 * `code` — no blocks, no nesting, no links. Just enough to make short
 * snippets and emphasis readable in a single-line row.
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
		else if (match[3] !== undefined) segments.push({ type: "italic", text: match[3] });
		lastIndex = INLINE_MARKDOWN.lastIndex;
	}
	if (lastIndex < text.length) segments.push({ type: "text", text: text.slice(lastIndex) });
	if (segments.length === 0) segments.push({ type: "text", text: "" });
	return segments;
}

const THEME_COLOR_KEYS: Array<keyof ThemeColors> = ["bg", "fg", "muted", "row_bg", "accent", "accent_fg", "border"];

export function isImportableThemeColors(value: unknown): value is ThemeColors {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return THEME_COLOR_KEYS.every((key) => typeof record[key] === "string" && record[key] !== "");
}

/** Validates untrusted clipboard JSON before it's handed to the `add_custom_theme` command. */
export function isImportableTheme(value: unknown): value is { name: string; mode: "light" | "dark"; colors: ThemeColors } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === "string" && record.name.length > 0 && (record.mode === "light" || record.mode === "dark") && isImportableThemeColors(record.colors);
}
