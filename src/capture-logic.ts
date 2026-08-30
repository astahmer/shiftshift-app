import type { Item, Template } from "./store";

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

export type UiCommand = { type: "open-settings" } | { type: "set-theme-mode"; mode: "light" | "dark" } | { type: "set-theme"; query: string };

/**
 * UI-level slash commands that don't create an item — checked before
 * `resolveCapture` so "/settings" etc. never fall through to being saved as
 * a literal note.
 */
export function parseUiCommand(raw: string): UiCommand | null {
	const trimmed = raw.trim();
	if (trimmed === "/settings") return { type: "open-settings" };
	if (trimmed === "/light" || trimmed === "/dark") return { type: "set-theme-mode", mode: trimmed.slice(1) as "light" | "dark" };
	if (trimmed.startsWith("/theme ")) return { type: "set-theme", query: trimmed.slice("/theme ".length) };
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

export const BUILTIN_COMMANDS: Array<{ name: string; hint: string }> = [
	{ name: "todo", hint: "Save as a todo" },
	{ name: "settings", hint: "Open settings" },
	{ name: "light", hint: "Switch to this theme's light sibling" },
	{ name: "dark", hint: "Switch to this theme's dark sibling" },
	{ name: "theme", hint: "Switch to a specific theme by name" },
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
