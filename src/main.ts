import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import {
	applySort,
	extractTags,
	filterItems,
	findDuplicate,
	formatRelativeTime,
	HELP_SHORTCUTS,
	isImportableTheme,
	lastToken,
	matchAtSuggestions,
	matchHashSuggestions,
	matchSlashSuggestions,
	matchSortSuggestions,
	matchThemeSuggestions,
	parseInlineMarkdown,
	parseSlashMode,
	parseUiCommand,
	resolveCapture,
	SORT_OPTIONS,
	type SlashMode,
	type SlashSuggestion,
	type ThemeChoice,
} from "./capture-logic";
import {
	Store,
	type Action,
	type CaptureMode,
	type CustomTheme,
	type HistoryEntry,
	type Item,
	type ItemKind,
	type LinkPreview,
	type MoveDirection,
	type S3Settings,
	type Settings,
	type SortMode,
	type SyncStatus,
	type Template,
	type ThemeColors,
} from "./store";
import { normalizeTheme, THEMES } from "./themes";

const app = document.getElementById("app")!;

const captureRow = document.createElement("div");
captureRow.className = "capture-row";
app.appendChild(captureRow);

const input = document.createElement("input");
input.className = "capture-input";
input.placeholder = "Capture anything…   / for commands   @ to filter";
captureRow.appendChild(input);

// Overlaid on the input's left padding — all suggestion rows (commands,
// theme, sort, history, @, #) used to look identical with no way to tell
// which "mode" you were in beyond reading the text.
const modeBadge = document.createElement("div");
modeBadge.className = "mode-badge";
modeBadge.hidden = true;
captureRow.appendChild(modeBadge);

const settingsBtn = document.createElement("button");
settingsBtn.className = "settings-btn";
settingsBtn.textContent = "⚙";
settingsBtn.title = "Settings";
settingsBtn.setAttribute("aria-label", "Settings");
captureRow.appendChild(settingsBtn);

const duplicateHint = document.createElement("div");
duplicateHint.className = "duplicate-hint";
duplicateHint.hidden = true;
duplicateHint.textContent = "Already saved — Enter adds it again";
app.appendChild(duplicateHint);

const list = document.createElement("div");
list.className = "item-list";
app.appendChild(list);

const metaBar = document.createElement("div");
metaBar.className = "meta-bar";
metaBar.hidden = true;
app.appendChild(metaBar);

const settingsView = document.createElement("div");
settingsView.className = "settings-view";
settingsView.hidden = true;
app.appendChild(settingsView);

const detailView = document.createElement("div");
detailView.className = "detail-view";
detailView.hidden = true;
app.appendChild(detailView);

const statusToast = document.createElement("div");
statusToast.className = "status-toast";
statusToast.hidden = true;
statusToast.setAttribute("role", "status");
statusToast.setAttribute("aria-live", "polite");
app.appendChild(statusToast);

let statusToastTimer: ReturnType<typeof setTimeout> | undefined;
/** Brief, self-dismissing confirmation — used for undo/redo, since those don't otherwise give any feedback that something happened. */
function showStatusToast(message: string, durationMs = 1800): void {
	statusToast.textContent = message;
	statusToast.hidden = false;
	clearTimeout(statusToastTimer);
	statusToastTimer = setTimeout(() => (statusToast.hidden = true), durationMs);
}

let items: Item[] = [];
let filtered: Item[] = [];
let templatesCache: Template[] = [];
let customThemesCache: CustomTheme[] = [];
let selected = -1;
let settings: Settings | null = null;
/** Built up with Shift+Enter; plain Enter copies all of these joined as a numbered list and closes. */
const multiSelected = new Set<string>();
let editingId: string | null = null;

/** Cached from the most recent render — commit/nav logic reads these rather than recomputing, so what gets acted on always matches what's on screen. */
let commandSuggestions: SlashSuggestion[] = [];
let themeSuggestions: ThemeChoice[] = [];
let sortSuggestions: Array<{ mode: SortMode; label: string }> = [];
let hashSuggestions: string[] = [];

/** Snapshot of `settings` taken the moment a `/theme`/`/light`/`/dark`/`/sort` live preview begins — lets Escape (or navigating away) revert without persisting. */
let previewSnapshot: Settings | null = null;

/** In-memory only, keyed by URL — refetched each launch. Favicons are displayed via a plain `<img src>`, which the webview loads cross-origin fine (CORS only blocks script-readable fetches, not image display), so only the title+favicon-URL lookup needs to go through Rust. */
const linkPreviewCache = new Map<string, LinkPreview | "loading">();

/** The item currently shown in the detail view (Shift+Right), if any. */
let detailItem: Item | null = null;
/** Id of the item currently being edited in the detail view's textarea, if any. */
let detailEditingId: string | null = null;

/**
 * Session-scoped (not persisted) undo/redo stacks for item mutations made
 * through this UI. Each entry carries enough state to reverse itself
 * exactly; `toggle_done`/`toggle_bookmarked` are self-inverse (undo == redo
 * == "do it again"), everything else records an explicit before/after.
 */
type UndoEntry =
	| { type: "add"; item: Item }
	| { type: "delete"; item: Item }
	| { type: "toggle_done"; id: string }
	| { type: "toggle_bookmarked"; id: string }
	| { type: "set_kind"; id: string; from: ItemKind; to: ItemKind }
	| { type: "update_text"; id: string; from: string; to: string }
	| { type: "move"; id: string; from: number; to: number }
	| { type: "bulk"; entries: UndoEntry[] };

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const UNDO_LIMIT = 100;

function pushUndo(entry: UndoEntry): void {
	undoStack.push(entry);
	if (undoStack.length > UNDO_LIMIT) undoStack.shift();
	redoStack.length = 0;
}

async function undoMutation(entry: UndoEntry): Promise<void> {
	switch (entry.type) {
		case "add":
			await Store.deleteItem(entry.item.id);
			break;
		case "delete":
			await Store.restoreItem(entry.item);
			break;
		case "toggle_done":
			await Store.toggleDone(entry.id);
			break;
		case "toggle_bookmarked":
			await Store.toggleBookmarked(entry.id);
			break;
		case "set_kind":
			await Store.setKind(entry.id, entry.from);
			break;
		case "update_text":
			await Store.updateItemText(entry.id, entry.from);
			break;
		case "move":
			await Store.setRank(entry.id, entry.from);
			break;
		case "bulk":
			for (const sub of entry.entries) await undoMutation(sub);
			break;
	}
}

async function redoMutation(entry: UndoEntry): Promise<void> {
	switch (entry.type) {
		case "add":
			await Store.restoreItem(entry.item);
			break;
		case "delete":
			await Store.deleteItem(entry.item.id);
			break;
		case "toggle_done":
			await Store.toggleDone(entry.id);
			break;
		case "toggle_bookmarked":
			await Store.toggleBookmarked(entry.id);
			break;
		case "set_kind":
			await Store.setKind(entry.id, entry.to);
			break;
		case "update_text":
			await Store.updateItemText(entry.id, entry.to);
			break;
		case "move":
			await Store.setRank(entry.id, entry.to);
			break;
		case "bulk":
			for (const sub of entry.entries) await redoMutation(sub);
			break;
	}
}

/** Applies the reverse of `entry`, refreshes once (even for a "bulk" entry covering many items), and shows a confirmation toast. */
async function applyUndoEntry(entry: UndoEntry): Promise<void> {
	await undoMutation(entry);
	await refresh();
}

/** Re-applies `entry`'s original mutation (the forward direction) — used by redo. */
async function applyRedoEntry(entry: UndoEntry): Promise<void> {
	await redoMutation(entry);
	await refresh();
}

/** ⌘1-⌘9: copy-and-close whatever's pinned to that slot, Raycast-favorites-style. */
async function actOnPinnedSlot(slotIndex: number): Promise<void> {
	const current = await loadSettings();
	const pinnedId = current.pinned_items[slotIndex];
	if (!pinnedId) {
		showStatusToast(`Nothing pinned to ⌘${slotIndex + 1} yet — ⌘⇧${slotIndex + 1} to pin the selected item`);
		return;
	}
	const item = items.find((i) => i.id === pinnedId);
	if (!item) {
		showStatusToast(`The item pinned to ⌘${slotIndex + 1} no longer exists`);
		return;
	}
	await actOnItem(item);
	await getCurrentWindow().hide();
}

/** ⌘⇧1-⌘⇧9: pins the currently keyboard-selected row to that slot, replacing whatever was there. */
async function assignPinnedSlot(slotIndex: number): Promise<void> {
	if (selected < 0 || !filtered[selected]) return;
	const current = await loadSettings();
	const next = { ...current, pinned_items: current.pinned_items.map((id, i) => (i === slotIndex ? filtered[selected]!.id : id)) };
	settings = next;
	await Store.setSettings(next);
	showStatusToast(`Pinned to ⌘${slotIndex + 1}`);
}

async function undo(): Promise<void> {
	const entry = undoStack.pop();
	if (!entry) return;
	await applyUndoEntry(entry);
	redoStack.push(entry);
	showStatusToast("Undid last action");
}

async function redo(): Promise<void> {
	const entry = redoStack.pop();
	if (!entry) return;
	await applyRedoEntry(entry);
	undoStack.push(entry);
	showStatusToast("Redid action");
}

function allThemeChoices(): ThemeChoice[] {
	return [
		...THEMES.map((t) => ({ id: t.id, label: t.label, mode: t.mode })),
		...customThemesCache.map((t) => ({ id: t.id, label: t.name, mode: t.mode })),
	];
}

function applyTheme(themeId: string): void {
	const root = document.documentElement;
	const custom = customThemesCache.find((t) => t.id === themeId);
	if (custom) {
		root.dataset.theme = "custom";
		root.style.setProperty("color-scheme", custom.mode);
		root.style.setProperty("--bg", custom.colors.bg);
		root.style.setProperty("--fg", custom.colors.fg);
		root.style.setProperty("--muted", custom.colors.muted);
		root.style.setProperty("--row-bg", custom.colors.row_bg);
		root.style.setProperty("--accent", custom.colors.accent);
		root.style.setProperty("--accent-fg", custom.colors.accent_fg);
		root.style.setProperty("--border", custom.colors.border);
	} else {
		for (const prop of ["--bg", "--fg", "--muted", "--row-bg", "--accent", "--accent-fg", "--border", "color-scheme"]) {
			root.style.removeProperty(prop);
		}
		root.dataset.theme = normalizeTheme(themeId);
	}
	// `panel_opacity` (Settings → Appearance) overrides whatever the theme
	// itself set for `--bg-alpha` — an independent "how see-through is the
	// panel" control, not tied to any one theme. 0 means "no override".
	if (settings && settings.panel_opacity > 0) {
		root.style.setProperty("--bg-alpha", `${settings.panel_opacity}%`);
	} else {
		root.style.removeProperty("--bg-alpha");
	}
}

async function loadSettings(): Promise<Settings> {
	if (!settings) {
		[settings, customThemesCache] = await Promise.all([Store.getSettings(), Store.listCustomThemes()]);
		applyTheme(settings.theme);
	}
	return settings;
}

function beginPreview(): void {
	if (!previewSnapshot && settings) previewSnapshot = { ...settings };
}

function cancelPreview(): void {
	if (previewSnapshot) {
		settings = previewSnapshot;
		applyTheme(settings.theme);
	}
	previewSnapshot = null;
}

async function commitPreview(): Promise<void> {
	if (settings) await Store.setSettings(settings);
	previewSnapshot = null;
}

function computeFiltered(): Item[] {
	return applySort(filterItems(items, input.value), settings?.sort_mode ?? "manual");
}

/** How many rows the currently-shown suggestion/item list has — arrow-key nav and Enter/Tab commit logic all key off this so they never drift from what's rendered. */
function currentSuggestionCount(raw: string): number {
	if (raw.startsWith("/")) {
		const mode = parseSlashMode(raw);
		if (mode.type === "theme" || mode.type === "light" || mode.type === "dark") {
			const filterMode = mode.type === "light" ? "light" : mode.type === "dark" ? "dark" : undefined;
			return matchThemeSuggestions(mode.type === "theme" ? mode.query : "", allThemeChoices(), filterMode).length;
		}
		if (mode.type === "sort") return matchSortSuggestions(mode.query).length;
		if (mode.type === "history") return 0;
		if (mode.type === "help") return 0;
		return matchSlashSuggestions(raw, templatesCache).length;
	}
	const partial = lastToken(raw);
	if (partial.startsWith("@")) return matchAtSuggestions(partial).length;
	if (partial.startsWith("#")) return matchHashSuggestions(partial, items).length;
	return computeFiltered().length;
}

function updateHint(): void {
	if (multiSelected.size > 0) {
		duplicateHint.hidden = false;
		duplicateHint.textContent = `${multiSelected.size} selected — Enter copies as a list, ⌘⌫ deletes, ⌘B/⌘T toggle bookmark/todo`;
		return;
	}
	duplicateHint.textContent = "Already saved — Enter adds it again";
	const query = input.value;
	const duplicate = !query.startsWith("/") && findDuplicate(items, query);
	duplicateHint.hidden = !duplicate;
}

const CONTENT_TYPE_LABELS: Record<ItemKind, string> = { note: "Text", todo: "Todo", link: "Link", image: "Image" };

function updateMetaBar(): void {
	const item = selected >= 0 ? filtered[selected] : undefined;
	if (!item || multiSelected.size > 0 || editingId !== null) {
		metaBar.hidden = true;
		return;
	}
	const parts: string[] = [];
	if (item.source_app) parts.push(`from ${item.source_app}`);
	parts.push(CONTENT_TYPE_LABELS[item.kind]);
	parts.push(`created ${formatRelativeTime(item.created_at)}`);
	if (item.copy_count > 0) {
		parts.push(`copied ${item.copy_count}×`);
		if (item.last_copied_at) parts.push(`last ${formatRelativeTime(item.last_copied_at)}`);
	}
	parts.push("⇧→ for details");
	metaBar.textContent = parts.join("   ·   ");
	metaBar.hidden = false;
}

function buildEmptyState(neverCaptured: boolean): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "empty-state";
	wrapper.textContent = neverCaptured
		? "Nothing captured yet — double-tap Shift, or type here and press ⌘Enter. Type /help for shortcuts."
		: "No matches for this filter.";
	return wrapper;
}

function isPreviewMode(mode: ReturnType<typeof parseSlashMode> | null): boolean {
	return mode !== null && (mode.type === "theme" || mode.type === "light" || mode.type === "dark" || mode.type === "sort");
}

/** Keeps the keyboard-highlighted row in view — without this, arrowing past the visible edge of the scrollable list moves the selection but leaves it invisible above/below the fold. */
function scrollSelectedIntoView(): void {
	list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

const MODE_BADGE_LABELS: Partial<Record<SlashMode["type"], string>> = {
	theme: "THEME",
	light: "THEME",
	dark: "THEME",
	sort: "SORT",
	history: "HISTORY",
	help: "HELP",
};

function updateModeBadge(raw: string, mode: SlashMode | null): void {
	let label: string | null = null;
	if (mode) {
		label = MODE_BADGE_LABELS[mode.type] ?? null;
	} else {
		const partial = lastToken(raw);
		if (partial.startsWith("@")) label = "FILTER";
		else if (partial.startsWith("#")) label = "TAG";
	}
	modeBadge.textContent = label ?? "";
	modeBadge.hidden = !label;
	input.classList.toggle("has-mode-badge", !!label);
}

function renderList(): void {
	const raw = input.value;
	const mode = raw.startsWith("/") ? parseSlashMode(raw) : null;
	updateModeBadge(raw, mode);
	if (previewSnapshot !== null && !isPreviewMode(mode)) {
		cancelPreview();
	}

	if (raw.startsWith("/")) {
		// Stale from before slash-mode was entered — item-row keyboard shortcuts
		// (bookmark/delete/etc, all guarded on `filtered[selected]`) must not
		// fire against it while browsing command suggestions instead.
		filtered = [];
		renderSlashSuggestions(raw);
		scrollSelectedIntoView();
		return;
	}
	const partial = lastToken(raw);
	if (partial.startsWith("@")) {
		filtered = [];
		renderAtSuggestions(partial);
		scrollSelectedIntoView();
		return;
	}
	if (partial.startsWith("#")) {
		filtered = [];
		renderHashSuggestions(partial);
		scrollSelectedIntoView();
		return;
	}
	filtered = computeFiltered();
	if (selected >= filtered.length) selected = filtered.length - 1;
	list.innerHTML = "";
	if (filtered.length === 0) {
		list.appendChild(buildEmptyState(items.length === 0));
	}
	filtered.forEach((item, index) => {
		list.appendChild(buildRow(item, index));
	});
	updateHint();
	updateMetaBar();
	scrollSelectedIntoView();
}

function renderSlashSuggestions(raw: string): void {
	list.innerHTML = "";
	duplicateHint.hidden = true;
	metaBar.hidden = true;
	const mode = parseSlashMode(raw);

	if (mode.type === "theme" || mode.type === "light" || mode.type === "dark") {
		const filterMode = mode.type === "light" ? "light" : mode.type === "dark" ? "dark" : undefined;
		const query = mode.type === "theme" ? mode.query : "";
		themeSuggestions = matchThemeSuggestions(query, allThemeChoices(), filterMode);
		if (selected >= themeSuggestions.length) selected = themeSuggestions.length - 1;
		if (selected < 0 && themeSuggestions.length > 0) selected = 0;
		beginPreview();
		const picked = themeSuggestions[selected];
		if (picked && settings) {
			settings.theme = picked.id;
			applyTheme(picked.id);
		}
		themeSuggestions.forEach((t, i) => list.appendChild(buildThemeSuggestionRow(t, i)));
		return;
	}

	if (mode.type === "sort") {
		sortSuggestions = matchSortSuggestions(mode.query);
		if (selected >= sortSuggestions.length) selected = sortSuggestions.length - 1;
		if (selected < 0 && sortSuggestions.length > 0) selected = 0;
		beginPreview();
		const picked = sortSuggestions[selected];
		if (picked && settings) settings.sort_mode = picked.mode;
		sortSuggestions.forEach((s, i) => list.appendChild(buildSortSuggestionRow(s, i)));
		return;
	}

	if (mode.type === "history") {
		void renderHistoryRows(mode.query);
		return;
	}

	if (mode.type === "help") {
		renderHelpRows();
		return;
	}

	commandSuggestions = matchSlashSuggestions(raw, templatesCache);
	if (selected >= commandSuggestions.length) selected = commandSuggestions.length - 1;
	commandSuggestions.forEach((suggestion, index) => list.appendChild(buildSuggestionRow(suggestion, index)));
}

function renderAtSuggestions(partial: string): void {
	const suggestions = matchAtSuggestions(partial);
	if (selected >= suggestions.length) selected = suggestions.length - 1;
	list.innerHTML = "";
	suggestions.forEach((s, i) => list.appendChild(buildAtSuggestionRow(s, i)));
	duplicateHint.hidden = true;
	metaBar.hidden = true;
}

async function renderHistoryRows(query: string): Promise<void> {
	const entries = await Store.listHistory(200);
	const q = query.trim().toLowerCase();
	const matching = q ? entries.filter((e) => e.action.toLowerCase().includes(q) || (e.detail ?? "").toLowerCase().includes(q)) : entries;
	// A newer keystroke may have landed while this was in flight — don't clobber it.
	if (input.value.trim() !== `/history ${query}`.trim()) return;
	list.innerHTML = "";
	if (matching.length === 0) {
		const empty = document.createElement("div");
		empty.className = "item-row";
		empty.textContent = "No history yet.";
		list.appendChild(empty);
		return;
	}
	for (const entry of matching) list.appendChild(buildHistoryEntryRow(entry));
}

function buildHistoryEntryRow(entry: HistoryEntry): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row";
	const time = document.createElement("span");
	time.className = "item-time item-time-history";
	time.textContent = formatRelativeTime(entry.at);
	row.appendChild(time);
	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = entry.detail ? `${entry.action}: ${entry.detail}` : entry.action;
	row.appendChild(text);
	return row;
}

let lastHelpCategory = "";

function renderHelpRows(): void {
	lastHelpCategory = "";
	for (const entry of HELP_SHORTCUTS) list.appendChild(buildHelpRow(entry));
	duplicateHint.hidden = true;
	metaBar.hidden = true;
}

function buildHelpRow(entry: (typeof HELP_SHORTCUTS)[number]): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row help-row";
	const category = document.createElement("span");
	category.className = "help-category";
	// Only label the first row of each category — repeating it on every row
	// would be noisier than the section-less grouping it's meant to replace.
	category.textContent = entry.category === lastHelpCategory ? "" : entry.category;
	lastHelpCategory = entry.category;
	row.appendChild(category);
	const shortcut = document.createElement("span");
	shortcut.className = "help-shortcut";
	shortcut.textContent = entry.shortcut;
	row.appendChild(shortcut);
	const description = document.createElement("span");
	description.className = "help-description";
	description.textContent = entry.description;
	row.appendChild(description);
	return row;
}

function buildSuggestionRow(suggestion: SlashSuggestion, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = () => {
		input.value = `/${suggestion.name} `;
		selected = -1;
		input.focus();
		renderList();
	};

	const icon = document.createElement("div");
	icon.className = "item-icon";
	icon.textContent = suggestion.kind === "template" ? "⚡" : "▸";
	row.appendChild(icon);

	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = `/${suggestion.name}`;
	row.appendChild(text);

	const hint = document.createElement("div");
	hint.className = "suggestion-hint";
	hint.textContent = suggestion.hint;
	row.appendChild(hint);

	return row;
}

function buildThemeSuggestionRow(theme: ThemeChoice, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = () => {
		selected = index;
		void commitHighlightedSuggestion();
	};

	const icon = document.createElement("div");
	icon.className = "item-icon";
	icon.textContent = theme.mode === "light" ? "☀" : "☾";
	row.appendChild(icon);

	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = theme.label;
	row.appendChild(text);

	const hint = document.createElement("div");
	hint.className = "suggestion-hint";
	hint.textContent = theme.mode;
	row.appendChild(hint);

	return row;
}

function buildSortSuggestionRow(option: { mode: SortMode; label: string }, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = () => {
		selected = index;
		void commitHighlightedSuggestion();
	};

	const icon = document.createElement("div");
	icon.className = "item-icon";
	icon.textContent = "↕";
	row.appendChild(icon);

	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = option.label;
	row.appendChild(text);

	return row;
}

function buildAtSuggestionRow(tag: { tag: string; hint: string }, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = () => completeAtToken(tag.tag);

	const icon = document.createElement("div");
	icon.className = "item-icon";
	icon.textContent = "@";
	row.appendChild(icon);

	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = `@${tag.tag}`;
	row.appendChild(text);

	const hint = document.createElement("div");
	hint.className = "suggestion-hint";
	hint.textContent = tag.hint;
	row.appendChild(hint);

	return row;
}

/** Replaces the in-progress `@partial` token (the last word) with the completed tag, then focuses back on normal filtering. */
function completeAtToken(tag: string): void {
	const tokens = input.value.split(/\s+/);
	tokens[tokens.length - 1] = `@${tag}`;
	input.value = `${tokens.join(" ")} `;
	selected = -1;
	input.focus();
	renderList();
}

function renderHashSuggestions(partial: string): void {
	hashSuggestions = matchHashSuggestions(partial, items);
	if (selected >= hashSuggestions.length) selected = hashSuggestions.length - 1;
	list.innerHTML = "";
	hashSuggestions.forEach((tag, i) => list.appendChild(buildHashSuggestionRow(tag, i)));
	duplicateHint.hidden = true;
	metaBar.hidden = true;
}

function buildHashSuggestionRow(tag: string, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = () => completeHashToken(tag);

	const icon = document.createElement("div");
	icon.className = "item-icon";
	icon.textContent = "#";
	row.appendChild(icon);

	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = `#${tag}`;
	row.appendChild(text);

	return row;
}

/** Same idea as `completeAtToken`, for an in-progress `#partial` token. */
function completeHashToken(tag: string): void {
	const tokens = input.value.split(/\s+/);
	tokens[tokens.length - 1] = `#${tag}`;
	input.value = `${tokens.join(" ")} `;
	selected = -1;
	input.focus();
	renderList();
}

/** Enter (or a click) on a highlighted theme/sort suggestion: persist what live-preview already applied, then return to the normal list. */
async function commitHighlightedSuggestion(): Promise<void> {
	const mode = parseSlashMode(input.value);
	if ((mode.type === "theme" || mode.type === "light" || mode.type === "dark") && themeSuggestions[selected]) {
		await commitPreview();
	} else if (mode.type === "sort" && sortSuggestions[selected]) {
		await commitPreview();
	}
	input.value = "";
	selected = -1;
	renderList();
}

function buildRow(item: Item, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row";
	row.dataset.done = String(item.done);
	row.dataset.bookmarked = String(item.bookmarked);
	row.classList.toggle("selected", index === selected);
	row.classList.toggle("multi-selected", multiSelected.has(item.id));
	row.onclick = () => {
		selected = index;
		renderList();
	};

	row.appendChild(buildIcon(item));

	if (editingId === item.id) {
		row.appendChild(buildEditInput(item));
	} else if (item.kind === "image") {
		const thumb = document.createElement("img");
		thumb.className = "item-thumb";
		thumb.src = convertFileSrc(item.text);
		thumb.onclick = (e) => {
			e.stopPropagation();
			void actOnItem(item);
		};
		row.appendChild(thumb);
	} else if (item.kind === "link") {
		row.appendChild(buildLinkContent(item));
	} else {
		const text = document.createElement("div");
		text.className = "item-text";
		for (const segment of parseInlineMarkdown(item.text)) {
			if (segment.type === "text") {
				text.appendChild(document.createTextNode(segment.text));
			} else {
				const span = document.createElement("span");
				span.className = `md-${segment.type}`;
				span.textContent = segment.text;
				text.appendChild(span);
			}
		}
		text.onclick = (e) => {
			e.stopPropagation();
			void actOnItem(item);
		};
		row.appendChild(text);
	}

	if (editingId !== item.id) {
		const time = document.createElement("span");
		time.className = "item-time";
		time.textContent = formatRelativeTime(item.created_at);
		row.appendChild(time);
	}

	const actions = document.createElement("div");
	actions.className = "item-actions";

	actions.appendChild(
		buildActionButton("item-bookmark", "Bookmark", item.bookmarked ? "★" : "☆", "⌘B", (e) => {
			e.stopPropagation();
			pushUndo({ type: "toggle_bookmarked", id: item.id });
			void Store.toggleBookmarked(item.id).then(refresh);
		}),
	);

	if (item.kind !== "image") {
		const isTodo = item.kind === "todo";
		actions.appendChild(
			buildActionButton("item-todo", isTodo ? "Remove from todos" : "Convert to todo", isTodo ? "▢" : "☑", "⌘T", (e) => {
				e.stopPropagation();
				const to = isTodo ? "note" : "todo";
				pushUndo({ type: "set_kind", id: item.id, from: item.kind, to });
				void Store.setKind(item.id, to).then(refresh);
			}),
		);
	}

	if (item.kind !== "image") {
		actions.appendChild(
			buildActionButton("item-edit", "Edit", "✎", "⌘E", (e) => {
				e.stopPropagation();
				startEditing(item.id);
			}),
		);
	}

	actions.appendChild(
		buildActionButton("item-share", "Share", "⤴", "⌘⇧S", (e) => {
			e.stopPropagation();
			void shareItem(item);
		}),
	);

	actions.appendChild(
		buildActionButton("item-delete", "Delete", "🗑", "⌫", (e) => {
			e.stopPropagation();
			pushUndo({ type: "delete", item });
			void Store.deleteItem(item.id)
				.then(refresh)
				.then(() => showStatusToast("Deleted — ⌘Z to undo"));
		}),
	);

	row.appendChild(actions);
	return row;
}

/** Icon button that also shows its keyboard shortcut as a small hint — visible while the row is selected, like shiftshift's help footer but inline. */
function buildActionButton(className: string, title: string, glyph: string, hint: string, onclick: (e: MouseEvent) => void): HTMLElement {
	const button = document.createElement("button");
	button.className = `item-action ${className}`;
	button.title = title;
	button.setAttribute("aria-label", title);
	button.onclick = onclick;

	const hintLabel = document.createElement("span");
	hintLabel.className = "item-action-hint";
	hintLabel.textContent = hint;
	button.appendChild(hintLabel);

	const icon = document.createElement("span");
	icon.textContent = glyph;
	button.appendChild(icon);

	return button;
}

/** Leading icon slot: an interactive checkbox for todos, a decorative kind glyph otherwise. */
function buildIcon(item: Item): HTMLElement {
	if (item.kind === "todo") {
		const check = document.createElement("div");
		check.className = "item-icon item-check";
		check.dataset.done = String(item.done);
		check.setAttribute("role", "checkbox");
		check.setAttribute("aria-checked", String(item.done));
		check.setAttribute("aria-label", item.done ? "Mark todo as not done" : "Mark todo as done");
		check.onclick = (e) => {
			e.stopPropagation();
			pushUndo({ type: "toggle_done", id: item.id });
			void Store.toggleDone(item.id).then(refresh);
		};
		return check;
	}
	const icon = document.createElement("div");
	icon.className = `item-icon item-icon-${item.kind}`;
	icon.textContent = item.kind === "link" ? "↗" : item.kind === "image" ? "▧" : "●";
	icon.setAttribute("aria-hidden", "true");
	return icon;
}

/** Title + favicon once fetched (see `loadLinkPreview`), the raw URL (as a native tooltip and as the fallback label) until then. */
function buildLinkContent(item: Item): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "item-text link-content";
	wrapper.title = item.text;
	wrapper.onclick = (e) => {
		e.stopPropagation();
		void actOnItem(item);
	};

	const cached = linkPreviewCache.get(item.text);
	if (cached && cached !== "loading" && cached.favicon) {
		const favicon = document.createElement("img");
		favicon.className = "item-favicon";
		favicon.src = cached.favicon;
		favicon.onerror = () => favicon.remove();
		wrapper.appendChild(favicon);
	}

	const label = document.createElement("span");
	label.className = "link-label";
	label.textContent = cached && cached !== "loading" && cached.title ? cached.title : item.text;
	wrapper.appendChild(label);

	if (!cached) {
		linkPreviewCache.set(item.text, "loading");
		void loadLinkPreview(item.text);
	}

	return wrapper;
}

async function loadLinkPreview(url: string): Promise<void> {
	try {
		linkPreviewCache.set(url, await Store.fetchLinkPreview(url));
	} catch {
		linkPreviewCache.set(url, { title: null, favicon: null });
	}
	renderList();
}

function startEditing(id: string): void {
	editingId = id;
	renderList();
}

function buildEditInput(item: Item): HTMLElement {
	const editInput = document.createElement("input");
	editInput.className = "item-edit-input";
	editInput.value = item.text;
	const commit = async (): Promise<void> => {
		const next = editInput.value.trim();
		editingId = null;
		if (next && next !== item.text) {
			pushUndo({ type: "update_text", id: item.id, from: item.text, to: next });
			await Store.updateItemText(item.id, next);
		}
		await refresh();
		input.focus();
	};
	editInput.onblur = () => void commit();
	editInput.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") void commit();
		if (e.key === "Escape") {
			editingId = null;
			renderList();
			input.focus();
		}
	};
	queueMicrotask(() => editInput.focus());
	return editInput;
}

/** Enter on a selected row: copy note/todo text, open a link, copy an image back to the clipboard. */
async function actOnItem(item: Item): Promise<void> {
	if (item.kind === "link") {
		await open(item.text);
	} else if (item.kind === "image") {
		await Store.copyImageToClipboard(item.text);
	} else {
		await navigator.clipboard.writeText(item.text);
		await Store.noteOwnClipboardWrite(item.text);
	}
	await Store.logUsed(item.id);
}

/**
 * Best reliable approximation of a native share sheet without adding a
 * Cocoa-binding dependency (see `reveal_in_finder`'s doc comment for why
 * `NSSharingService` itself doesn't work from a spawned process): images
 * get revealed in Finder, where its own Share button has full AirDrop/
 * Mail/Messages/etc access; everything else opens a prefilled Mail compose
 * window via the `mailto:` URL scheme, which is reliable with no Cocoa
 * calls at all.
 */
async function shareItem(item: Item): Promise<void> {
	if (item.kind === "image") {
		await Store.revealInFinder(item.text);
		return;
	}
	const subject = encodeURIComponent("Shared from shiftshift");
	const body = encodeURIComponent(item.text);
	await open(`mailto:?subject=${subject}&body=${body}`);
}

/** Plain Enter with a multi-selection built up via Shift+Enter: join as a numbered list, copy, close. */
async function copyMultiSelectionAndClose(): Promise<void> {
	const ordered = items.filter((item) => multiSelected.has(item.id));
	const joined = ordered.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
	await navigator.clipboard.writeText(joined);
	await Store.noteOwnClipboardWrite(joined);
	for (const item of ordered) await Store.logUsed(item.id);
	multiSelected.clear();
	await getCurrentWindow().hide();
}

/** Deletes every multi-selected item as one undoable action, then clears the selection. */
async function bulkDelete(): Promise<void> {
	const selected = items.filter((item) => multiSelected.has(item.id));
	if (selected.length === 0) return;
	for (const item of selected) await Store.deleteItem(item.id);
	pushUndo({ type: "bulk", entries: selected.map((item) => ({ type: "delete", item })) });
	multiSelected.clear();
	await refresh();
	showStatusToast(`Deleted ${selected.length} item${selected.length === 1 ? "" : "s"}`);
}

/** Toggles each multi-selected item's own bookmark state independently — mirrors the single-item shortcut, just applied to N items. */
async function bulkToggleBookmark(): Promise<void> {
	const selected = items.filter((item) => multiSelected.has(item.id));
	if (selected.length === 0) return;
	for (const item of selected) await Store.toggleBookmarked(item.id);
	pushUndo({ type: "bulk", entries: selected.map((item) => ({ type: "toggle_bookmarked", id: item.id })) });
	await refresh();
	showStatusToast(`Toggled bookmark on ${selected.length} item${selected.length === 1 ? "" : "s"}`);
}

/** Toggles each multi-selected item's own todo/note kind independently, like the single-item ⌘T shortcut. */
async function bulkToggleTodo(): Promise<void> {
	const selected = items.filter((item) => multiSelected.has(item.id) && item.kind !== "image");
	if (selected.length === 0) return;
	const entries: UndoEntry[] = [];
	for (const item of selected) {
		const to: ItemKind = item.kind === "todo" ? "note" : "todo";
		await Store.setKind(item.id, to);
		entries.push({ type: "set_kind", id: item.id, from: item.kind, to });
	}
	pushUndo({ type: "bulk", entries });
	await refresh();
	showStatusToast(`Toggled todo on ${selected.length} item${selected.length === 1 ? "" : "s"}`);
}

function formatAbsoluteTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function buildDetailMetaRow(label: string, value: string): HTMLElement {
	const row = document.createElement("div");
	row.className = "detail-meta-row";
	const labelEl = document.createElement("span");
	labelEl.textContent = label;
	row.appendChild(labelEl);
	const valueEl = document.createElement("span");
	valueEl.textContent = value;
	row.appendChild(valueEl);
	return row;
}

function buildDetailEditTextarea(item: Item): HTMLElement {
	const wrapper = document.createElement("div");

	const textarea = document.createElement("textarea");
	textarea.className = "detail-edit-textarea";
	textarea.value = item.text;
	const commit = async (): Promise<void> => {
		const next = textarea.value.trim();
		detailEditingId = null;
		if (next && next !== item.text) {
			pushUndo({ type: "update_text", id: item.id, from: item.text, to: next });
			await Store.updateItemText(item.id, next);
		}
		await refresh();
	};
	textarea.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
		if (e.key === "Escape") {
			detailEditingId = null;
			buildDetailView(item);
		}
	};
	wrapper.appendChild(textarea);

	const actions = document.createElement("div");
	actions.className = "detail-actions";
	const saveBtn = document.createElement("button");
	saveBtn.textContent = "Save (⌘Enter)";
	saveBtn.onclick = () => void commit();
	actions.appendChild(saveBtn);
	const cancelBtn = document.createElement("button");
	cancelBtn.textContent = "Cancel (Esc)";
	cancelBtn.onclick = () => {
		detailEditingId = null;
		buildDetailView(item);
	};
	actions.appendChild(cancelBtn);
	wrapper.appendChild(actions);

	queueMicrotask(() => textarea.focus());
	return wrapper;
}

function buildDetailTags(item: Item): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "detail-tags-section";

	const tags = extractTags([item]);
	if (tags.length > 0) {
		const pills = document.createElement("div");
		pills.className = "detail-tags";
		for (const tag of tags) {
			const pill = document.createElement("span");
			pill.className = "md-tag";
			pill.textContent = `#${tag}`;
			pills.appendChild(pill);
		}
		wrapper.appendChild(pills);
	}

	const addRow = document.createElement("div");
	addRow.className = "detail-add-tag";
	const tagInput = document.createElement("input");
	tagInput.placeholder = "Add a tag";
	// Native <datalist> autocomplete against tags already in use elsewhere —
	// avoids accidentally forking "work" vs "worklife" by typo, matching the
	// `#` suggestion mode's tag source.
	const existingTags = extractTags(items);
	if (existingTags.length > 0) {
		const datalist = document.createElement("datalist");
		datalist.id = `tag-suggestions-${item.id}`;
		for (const tag of existingTags) {
			const option = document.createElement("option");
			option.value = tag;
			datalist.appendChild(option);
		}
		tagInput.setAttribute("list", datalist.id);
		addRow.appendChild(datalist);
	}
	const addTag = async (): Promise<void> => {
		const clean = tagInput.value.trim().replace(/^#/, "").replace(/\s+/g, "-");
		if (!clean) return;
		const next = `${item.text} #${clean}`;
		pushUndo({ type: "update_text", id: item.id, from: item.text, to: next });
		await Store.updateItemText(item.id, next);
		await refresh();
	};
	tagInput.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") void addTag();
	};
	addRow.appendChild(tagInput);
	const addBtn = document.createElement("button");
	addBtn.textContent = "Add";
	addBtn.onclick = () => void addTag();
	addRow.appendChild(addBtn);
	wrapper.appendChild(addRow);

	return wrapper;
}

/** Full, untruncated view of a single item (Shift+Right) — dates, copy stats, tags, and the complete rendered text/edit form, none of which fit in the compact row or meta-bar. */
function buildDetailView(item: Item): void {
	detailView.innerHTML = "";

	if (detailEditingId === item.id) {
		detailView.appendChild(buildDetailEditTextarea(item));
		return;
	}

	if (item.kind === "image") {
		const img = document.createElement("img");
		img.className = "detail-image";
		img.src = convertFileSrc(item.text);
		detailView.appendChild(img);
	} else if (item.kind === "link") {
		const cached = linkPreviewCache.get(item.text);
		if (cached && cached !== "loading" && cached.title) {
			const title = document.createElement("div");
			title.className = "detail-text";
			title.textContent = cached.title;
			detailView.appendChild(title);
		}
		const link = document.createElement("div");
		link.className = "detail-link";
		link.textContent = item.text;
		link.onclick = () => void open(item.text);
		detailView.appendChild(link);
	} else {
		const text = document.createElement("div");
		text.className = "detail-text";
		for (const segment of parseInlineMarkdown(item.text)) {
			if (segment.type === "text") {
				text.appendChild(document.createTextNode(segment.text));
			} else {
				const span = document.createElement("span");
				span.className = `md-${segment.type}`;
				span.textContent = segment.text;
				text.appendChild(span);
			}
		}
		detailView.appendChild(text);
	}

	if (item.kind !== "image") detailView.appendChild(buildDetailTags(item));

	const meta = document.createElement("div");
	meta.className = "detail-meta";
	meta.appendChild(buildDetailMetaRow("Content type", CONTENT_TYPE_LABELS[item.kind]));
	if (item.source_app) meta.appendChild(buildDetailMetaRow("Source", item.source_app));
	meta.appendChild(buildDetailMetaRow("Bookmarked", item.bookmarked ? "Yes" : "No"));
	meta.appendChild(buildDetailMetaRow("Created", formatAbsoluteTime(item.created_at)));
	if (item.copy_count > 0) {
		meta.appendChild(buildDetailMetaRow("Copied", `${item.copy_count}×`));
		if (item.first_copied_at) meta.appendChild(buildDetailMetaRow("First copied", formatAbsoluteTime(item.first_copied_at)));
		if (item.last_copied_at) meta.appendChild(buildDetailMetaRow("Last copied", formatAbsoluteTime(item.last_copied_at)));
	}
	detailView.appendChild(meta);

	const actions = document.createElement("div");
	actions.className = "detail-actions";

	const bookmarkBtn = document.createElement("button");
	bookmarkBtn.textContent = item.bookmarked ? "★ Unbookmark" : "☆ Bookmark";
	bookmarkBtn.onclick = async () => {
		pushUndo({ type: "toggle_bookmarked", id: item.id });
		await Store.toggleBookmarked(item.id);
		await refresh();
	};
	actions.appendChild(bookmarkBtn);

	if (item.kind !== "image") {
		const isTodo = item.kind === "todo";
		const todoBtn = document.createElement("button");
		todoBtn.textContent = isTodo ? "Remove from todos" : "Convert to todo";
		todoBtn.onclick = async () => {
			const to = isTodo ? "note" : "todo";
			pushUndo({ type: "set_kind", id: item.id, from: item.kind, to });
			await Store.setKind(item.id, to);
			await refresh();
		};
		actions.appendChild(todoBtn);

		const editBtn = document.createElement("button");
		editBtn.textContent = "Edit";
		editBtn.onclick = () => {
			detailEditingId = item.id;
			buildDetailView(item);
		};
		actions.appendChild(editBtn);
	}

	const shareBtn = document.createElement("button");
	shareBtn.textContent = "Share";
	shareBtn.onclick = () => void shareItem(item);
	actions.appendChild(shareBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.textContent = "Delete";
	deleteBtn.onclick = async () => {
		pushUndo({ type: "delete", item });
		await Store.deleteItem(item.id);
		closeDetail();
		await refresh();
		showStatusToast("Deleted — ⌘Z to undo");
	};
	actions.appendChild(deleteBtn);

	detailView.appendChild(actions);

	const hint = document.createElement("div");
	hint.className = "detail-hint";
	hint.textContent = "⇧← or Esc to go back";
	detailView.appendChild(hint);
}

function showDetail(item: Item): void {
	detailItem = item;
	detailEditingId = null;
	buildDetailView(item);
	detailView.hidden = false;
	list.hidden = true;
	metaBar.hidden = true;
}

function closeDetail(): void {
	detailItem = null;
	detailEditingId = null;
	detailView.hidden = true;
	list.hidden = false;
	input.focus();
	renderList();
}

async function refresh(): Promise<void> {
	[items, templatesCache] = await Promise.all([Store.listItems(), Store.listTemplates()]);
	if (detailItem && !detailView.hidden) {
		const updated = items.find((i) => i.id === detailItem!.id);
		if (updated) {
			detailItem = updated;
			buildDetailView(updated);
		} else {
			closeDetail();
		}
	}
	renderList();
}

async function saveNew(raw: string): Promise<void> {
	const templates = raw.startsWith("/") ? await Store.listTemplates() : [];
	const { text, kind } = resolveCapture(raw, templates);
	const item = await Store.addItem(text, kind);
	pushUndo({ type: "add", item });
	input.value = "";
	selected = -1;
	await refresh();
}

/**
 * Handles Enter for the generic "commands" slash mode (builtins + snippet
 * templates). If the typed command name isn't an exact match yet and a
 * suggestion is highlighted, Enter completes it into the input (like Tab)
 * instead of saving the partial text as a literal note — that mismatch was
 * the "/theme ends up as a saved item" bug, generalized to every command.
 */
async function handleSlashEnter(raw: string): Promise<void> {
	const uiCommand = parseUiCommand(raw);
	if (uiCommand?.type === "open-settings") {
		await openSettings();
		input.value = "";
		return;
	}
	const suggestions = matchSlashSuggestions(raw, templatesCache);
	const typedName = (raw.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
	const exactMatch = suggestions.some((s) => s.name.toLowerCase() === typedName);
	if (!exactMatch && selected >= 0 && suggestions[selected]) {
		input.value = `/${suggestions[selected]!.name} `;
		selected = -1;
		renderList();
		return;
	}
	await saveNew(raw);
}

async function setTheme(themeId: string): Promise<void> {
	const current = await loadSettings();
	const next = { ...current, theme: themeId };
	settings = next;
	applyTheme(themeId);
	await Store.setSettings(next);
}

// Keyboard shortcuts live on `document`, not just `input`: clicking a row
// action button (bookmark/edit/delete) moves focus to that button, and a
// listener scoped to `input` would then never see the following keypress —
// that was the "Escape doesn't hide after clicking an item" bug.
document.addEventListener("keydown", async (e) => {
	if (e.key === "Escape") {
		e.preventDefault();
		if (previewSnapshot !== null) {
			cancelPreview();
			input.value = "";
			selected = -1;
			renderList();
			return;
		}
		if (multiSelected.size > 0) {
			multiSelected.clear();
			renderList();
			return;
		}
		if (!settingsView.hidden) {
			closeSettings();
			return;
		}
		if (!detailView.hidden) {
			closeDetail();
			return;
		}
		await getCurrentWindow().hide();
		return;
	}

	// Settings' own form controls (selects, the shortcut recorder) need native
	// keyboard behavior; the item-list shortcuts below don't apply there.
	if (!settingsView.hidden) return;
	if (!detailView.hidden) {
		if (e.shiftKey && e.key === "ArrowLeft") {
			e.preventDefault();
			closeDetail();
			return;
		}
		// Quick-look style browsing — move to the next/previous item's detail
		// without backing out to the list first.
		if ((e.key === "ArrowDown" || e.key === "ArrowUp") && detailItem) {
			e.preventDefault();
			const currentIndex = filtered.findIndex((i) => i.id === detailItem!.id);
			if (currentIndex >= 0) {
				const nextIndex = e.key === "ArrowDown" ? Math.min(currentIndex + 1, filtered.length - 1) : Math.max(currentIndex - 1, 0);
				if (filtered[nextIndex] && nextIndex !== currentIndex) {
					selected = nextIndex;
					showDetail(filtered[nextIndex]!);
				}
			}
		}
		return;
	}
	// The inline edit input already handles its own keys and stops
	// propagation, but guard anyway in case focus is elsewhere mid-edit.
	if (editingId !== null) return;

	const modKey = e.metaKey || e.ctrlKey;
	const raw = input.value;
	const slashMode = raw.startsWith("/") ? parseSlashMode(raw) : null;
	const lastWord = !raw.startsWith("/") ? lastToken(raw) : "";
	const inAtMode = lastWord.startsWith("@");
	const inHashMode = lastWord.startsWith("#");

	if (e.key === "Tab") {
		if (slashMode?.type === "commands") {
			e.preventDefault();
			const suggestions = matchSlashSuggestions(raw, templatesCache);
			const pick = selected >= 0 ? suggestions[selected] : suggestions[0];
			if (pick) {
				input.value = `/${pick.name} `;
				selected = -1;
				renderList();
			}
			return;
		}
		if (inAtMode) {
			e.preventDefault();
			const suggestions = matchAtSuggestions(lastWord);
			const pick = selected >= 0 ? suggestions[selected] : suggestions[0];
			if (pick) completeAtToken(pick.tag);
			return;
		}
		if (inHashMode) {
			e.preventDefault();
			const suggestions = matchHashSuggestions(lastWord, items);
			const pick = selected >= 0 ? suggestions[selected] : suggestions[0];
			if (pick) completeHashToken(pick);
			return;
		}
	}

	// Only in the unfiltered (full, rank-ordered) view — a filtered view's
	// visual neighbors aren't necessarily rank-adjacent, so "move up" could
	// jump somewhere that doesn't look like "up" at all.
	if (e.altKey && input.value === "" && (e.key === "ArrowUp" || e.key === "ArrowDown") && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const direction: MoveDirection = e.key === "ArrowUp" ? "up" : "down";
		const movedId = filtered[selected]!.id;
		const fromRank = filtered[selected]!.rank;
		await Store.moveItem(movedId, direction);
		await refresh();
		const movedItem = items.find((i) => i.id === movedId);
		if (movedItem) pushUndo({ type: "move", id: movedId, from: fromRank, to: movedItem.rank });
		// `refresh` re-renders with the stale numeric `selected`, which no
		// longer points at the item we just moved — find where it landed so
		// holding the key keeps moving the *same* item, not whatever else
		// happens to occupy that slot next.
		const newIndex = filtered.findIndex((i) => i.id === movedId);
		if (newIndex >= 0) selected = newIndex;
		renderList();
		return;
	}
	// Wraps at both ends (last -> first going down, first -> last going up)
	// rather than clamping, so cycling through a short list doesn't require
	// backtracking once you overshoot an end.
	if (e.key === "ArrowDown") {
		e.preventDefault();
		const count = currentSuggestionCount(raw);
		if (count > 0) selected = selected < 0 ? 0 : (selected + 1) % count;
		renderList();
		return;
	}
	if (e.key === "ArrowUp") {
		e.preventDefault();
		const count = currentSuggestionCount(raw);
		if (count > 0) selected = selected < 0 ? count - 1 : (selected - 1 + count) % count;
		renderList();
		return;
	}
	if (e.key === " " && input.value === "" && selected >= 0 && filtered[selected]?.kind === "todo") {
		e.preventDefault();
		pushUndo({ type: "toggle_done", id: filtered[selected]!.id });
		await Store.toggleDone(filtered[selected]!.id);
		await refresh();
		return;
	}
	// Cmd+Delete/Backspace, not the bare key — an accidental bare Delete/
	// Backspace while just browsing the list (input empty, a row focused)
	// used to delete it outright with no confirmation. With a multi-
	// selection active, these act on the whole selection instead of just
	// the highlighted row.
	if (modKey && (e.key === "Backspace" || e.key === "Delete") && input.value === "" && multiSelected.size > 0) {
		e.preventDefault();
		await bulkDelete();
		return;
	}
	if (modKey && (e.key === "Backspace" || e.key === "Delete") && input.value === "" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const item = filtered[selected]!;
		pushUndo({ type: "delete", item });
		await Store.deleteItem(item.id);
		await refresh();
		showStatusToast("Deleted — ⌘Z to undo");
		return;
	}
	if (modKey && e.key.toLowerCase() === "b" && multiSelected.size > 0) {
		e.preventDefault();
		await bulkToggleBookmark();
		return;
	}
	if (modKey && e.key.toLowerCase() === "b" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		pushUndo({ type: "toggle_bookmarked", id: filtered[selected]!.id });
		await Store.toggleBookmarked(filtered[selected]!.id);
		await refresh();
		return;
	}
	if (modKey && e.key.toLowerCase() === "e" && selected >= 0 && filtered[selected] && filtered[selected]!.kind !== "image") {
		e.preventDefault();
		startEditing(filtered[selected]!.id);
		return;
	}
	if (modKey && e.shiftKey && e.key.toLowerCase() === "s" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		await shareItem(filtered[selected]!);
		return;
	}
	if (modKey && e.key.toLowerCase() === "t" && multiSelected.size > 0) {
		e.preventDefault();
		await bulkToggleTodo();
		return;
	}
	if (modKey && e.key.toLowerCase() === "t" && selected >= 0 && filtered[selected] && filtered[selected]!.kind !== "image") {
		e.preventDefault();
		const current = filtered[selected]!;
		const to = current.kind === "todo" ? "note" : "todo";
		pushUndo({ type: "set_kind", id: current.id, from: current.kind, to });
		await Store.setKind(current.id, to);
		await refresh();
		return;
	}
	if (modKey && e.key.toLowerCase() === "z" && input.value === "") {
		e.preventDefault();
		if (e.shiftKey) await redo();
		else await undo();
		return;
	}
	// `e.code` (physical key), not `e.key` — Shift+1 on a US layout reports
	// `e.key === "!"`, so checking `e.key` would silently miss ⌘⇧1-⌘⇧9.
	const pinnedSlotMatch = /^Digit([1-9])$/.exec(e.code);
	if (modKey && pinnedSlotMatch && !slashMode && !inAtMode && !inHashMode) {
		e.preventDefault();
		const slotIndex = Number(pinnedSlotMatch[1]) - 1;
		if (e.shiftKey) await assignPinnedSlot(slotIndex);
		else await actOnPinnedSlot(slotIndex);
		return;
	}
	if (modKey && e.key.toLowerCase() === "c" && input.value === "" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		await actOnItem(filtered[selected]!);
		return;
	}
	if (e.shiftKey && e.key === "ArrowRight" && input.value === "" && selected >= 0 && filtered[selected] && detailView.hidden) {
		e.preventDefault();
		showDetail(filtered[selected]!);
		return;
	}

	if (e.key !== "Enter") return;

	if (slashMode && slashMode.type !== "commands") {
		e.preventDefault();
		if (slashMode.type === "history" || slashMode.type === "help") {
			input.value = "";
			selected = -1;
			renderList();
		} else {
			await commitHighlightedSuggestion();
		}
		return;
	}

	if (inAtMode) {
		e.preventDefault();
		const suggestions = matchAtSuggestions(lastWord);
		if (selected >= 0 && suggestions[selected]) completeAtToken(suggestions[selected]!.tag);
		return;
	}

	if (inHashMode) {
		e.preventDefault();
		const suggestions = matchHashSuggestions(lastWord, items);
		if (selected >= 0 && suggestions[selected]) completeHashToken(suggestions[selected]!);
		return;
	}

	if (e.shiftKey && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const id = filtered[selected]!.id;
		if (multiSelected.has(id)) multiSelected.delete(id);
		else multiSelected.add(id);
		if (filtered.length > 0) selected = Math.min(selected + 1, filtered.length - 1);
		renderList();
		return;
	}

	const trimmed = input.value.trim();

	if (!trimmed) {
		// The common "just browsing, nothing typed" case — this used to
		// `return` unconditionally here, before ever reaching the
		// act-on-selected-item branch below, so Enter silently did nothing.
		if (multiSelected.size > 0) {
			await copyMultiSelectionAndClose();
		} else if (selected >= 0 && filtered[selected]) {
			await actOnItem(filtered[selected]!);
			await getCurrentWindow().hide();
		}
		return;
	}

	if (modKey) {
		await saveNew(trimmed);
		return;
	}
	if (trimmed.startsWith("/")) {
		await handleSlashEnter(trimmed);
		return;
	}
	if (multiSelected.size > 0) {
		await copyMultiSelectionAndClose();
		return;
	}
	if (selected >= 0 && filtered[selected]) {
		await actOnItem(filtered[selected]!);
		await getCurrentWindow().hide();
		return;
	}
	await saveNew(trimmed);
});

input.addEventListener("input", () => {
	const raw = input.value;
	const count = currentSuggestionCount(raw);
	selected = count > 0 ? 0 : -1;
	renderList();
});

// Pasting an image (⌘V with one on the clipboard) saves it as an image item
// instead of pasting nothing/garbage into the text input — the natural
// answer to "how do I capture an image" that doesn't require knowing about
// the dedicated shortcut or Settings → Images.
input.addEventListener("paste", (e) => {
	const hasImage = Array.from(e.clipboardData?.items ?? []).some((item) => item.type.startsWith("image/"));
	if (!hasImage) return;
	e.preventDefault();
	void (async () => {
		try {
			const item = await Store.captureClipboardImage();
			pushUndo({ type: "add", item });
			await refresh();
		} catch (err) {
			showStatusToast(String(err));
		}
	})();
});

// The Rust side emits "refresh" after any mutation made outside this window
// (capture-selection hotkey, tray actions, CLI capture) so the list stays
// in sync without polling.
listen("refresh", () => void refresh());

// Draft capture mode (Settings -> Capture behavior): the text was grabbed
// but not saved yet — land it in the input for review instead.
listen<string>("draft-capture", (event) => {
	input.value = event.payload;
	selected = -1;
	renderList();
	input.focus();
});

window.addEventListener("focus", () => input.focus());

// "Click outside to close": the panel is always-on-top with no title bar, so
// losing OS focus (clicking another app, or empty desktop) is the only
// "outside" there is. Opt-out via Settings -> hide_on_blur.
window.addEventListener("blur", () => {
	if (settings?.hide_on_blur ?? true) void getCurrentWindow().hide();
});

const ACTION_LABELS: Record<Action, string> = {
	capture: "Capture selection",
	toggle_panel: "Toggle panel",
	none: "Do nothing",
};

function buildBindingRow(label: string, key: "left" | "right", current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = label;
	row.appendChild(name);

	const select = document.createElement("select");
	for (const action of Object.keys(ACTION_LABELS) as Action[]) {
		const option = document.createElement("option");
		option.value = action;
		option.textContent = ACTION_LABELS[action];
		option.selected = current.bindings[key] === action;
		select.appendChild(option);
	}
	select.onchange = async () => {
		const next = { ...current, bindings: { ...current.bindings, [key]: select.value as Action } };
		settings = next;
		await Store.setSettings(next);
	};
	row.appendChild(select);
	return row;
}

function buildThemeRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "Theme";
	row.appendChild(name);

	const select = document.createElement("select");
	const builtinGroup = document.createElement("optgroup");
	builtinGroup.label = "Built-in";
	for (const theme of THEMES) {
		const option = document.createElement("option");
		option.value = theme.id;
		option.textContent = theme.label;
		option.selected = current.theme === theme.id;
		builtinGroup.appendChild(option);
	}
	select.appendChild(builtinGroup);
	if (customThemesCache.length > 0) {
		const customGroup = document.createElement("optgroup");
		customGroup.label = "Custom";
		for (const theme of customThemesCache) {
			const option = document.createElement("option");
			option.value = theme.id;
			option.textContent = theme.name;
			option.selected = current.theme === theme.id;
			customGroup.appendChild(option);
		}
		select.appendChild(customGroup);
	}
	select.onchange = () => void setTheme(select.value);
	row.appendChild(select);
	return row;
}

function buildSortRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "Sort order";
	row.appendChild(name);

	const select = document.createElement("select");
	for (const option of SORT_OPTIONS) {
		const opt = document.createElement("option");
		opt.value = option.mode;
		opt.textContent = option.label;
		opt.selected = current.sort_mode === option.mode;
		select.appendChild(opt);
	}
	select.onchange = async () => {
		const next = { ...current, sort_mode: select.value as SortMode };
		settings = next;
		await Store.setSettings(next);
	};
	row.appendChild(select);
	return row;
}

/** 0 = no override, use whatever the active theme sets for `--bg-alpha`. */
function buildOpacityRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "Panel opacity";
	row.appendChild(name);

	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "15";
	slider.max = "100";
	slider.value = String(current.panel_opacity > 0 ? current.panel_opacity : 50);
	slider.disabled = current.panel_opacity === 0;
	const readout = document.createElement("span");
	readout.className = "opacity-readout";
	readout.textContent = `${slider.value}%`;
	slider.oninput = () => {
		readout.textContent = `${slider.value}%`;
		if (settings) {
			settings.panel_opacity = Number(slider.value);
			applyTheme(settings.theme);
		}
	};
	slider.onchange = async () => {
		if (!settings) return;
		await Store.setSettings(settings);
	};
	row.appendChild(slider);
	row.appendChild(readout);

	const resetBtn = document.createElement("button");
	resetBtn.textContent = current.panel_opacity === 0 ? "Override theme opacity" : "Use theme default";
	resetBtn.onclick = async () => {
		const next = { ...current, panel_opacity: current.panel_opacity === 0 ? 50 : 0 };
		settings = next;
		applyTheme(next.theme);
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(resetBtn);

	return row;
}

/** A label + checkbox settings row; `patch` returns the settings update to persist. */
function buildCheckboxRow(label: string, checked: boolean, disabled: boolean, patch: (checked: boolean) => Partial<Settings>): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	const labelEl = document.createElement("label");
	labelEl.textContent = label;
	row.appendChild(labelEl);
	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.checked = checked;
	checkbox.disabled = disabled;
	checkbox.onchange = async () => {
		const current = await loadSettings();
		const next = { ...current, ...patch(checkbox.checked) };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(checkbox);
	return row;
}

function buildNotificationRows(current: Settings): HTMLElement[] {
	return [
		buildCheckboxRow("Notify when something is saved", current.notify_on_save, false, (checked) => ({ notify_on_save: checked })),
		buildCheckboxRow("Play a sound", current.notify_sound, !current.notify_on_save, (checked) => ({ notify_sound: checked })),
	];
}

const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
	silent: "Silent — save without showing the panel",
	open: "Open — save and show the panel",
	draft: "Draft — show the panel with the text prefilled, not yet saved",
};

function buildCaptureModeRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "When capturing";
	row.appendChild(name);

	const select = document.createElement("select");
	for (const mode of Object.keys(CAPTURE_MODE_LABELS) as CaptureMode[]) {
		const option = document.createElement("option");
		option.value = mode;
		option.textContent = CAPTURE_MODE_LABELS[mode];
		option.selected = current.capture_mode === mode;
		select.appendChild(option);
	}
	select.onchange = async () => {
		const next = { ...current, capture_mode: select.value as CaptureMode };
		settings = next;
		await Store.setSettings(next);
	};
	row.appendChild(select);
	return row;
}

function buildBehaviorRows(current: Settings): HTMLElement[] {
	return [
		buildCheckboxRow("Hide when the panel loses focus", current.hide_on_blur, false, (checked) => ({ hide_on_blur: checked })),
		buildCheckboxRow(
			"Auto-capture everything copied (clipboard watch)",
			current.clipboard_watch,
			false,
			(checked) => ({ clipboard_watch: checked }),
		),
		buildCheckboxRow("Launch at login", current.launch_at_login, false, (checked) => ({ launch_at_login: checked })),
	];
}

function buildPinnedItemsSection(current: Settings): HTMLElement {
	const wrapper = document.createElement("div");
	for (let slot = 0; slot < 9; slot++) {
		const id = current.pinned_items[slot];
		const item = id ? items.find((i) => i.id === id) : undefined;
		const row = document.createElement("div");
		row.className = "settings-row";
		const label = document.createElement("label");
		label.textContent = `⌘${slot + 1}`;
		row.appendChild(label);
		const value = document.createElement("span");
		value.className = "pinned-item-value";
		value.textContent = item ? item.text : id ? "(item no longer exists)" : "Not set — select a row, ⌘⇧" + (slot + 1);
		row.appendChild(value);
		if (id) {
			const clearBtn = document.createElement("button");
			clearBtn.textContent = "Clear";
			clearBtn.onclick = async () => {
				const next = { ...current, pinned_items: current.pinned_items.map((v, i) => (i === slot ? "" : v)) };
				settings = next;
				await Store.setSettings(next);
				await openSettings();
			};
			row.appendChild(clearBtn);
		}
		wrapper.appendChild(row);
	}
	return wrapper;
}

/** One app name per line — parsed/joined on blur rather than per-keystroke, since a half-typed name shouldn't affect matching. */
function buildExcludedAppsRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row excluded-apps-row";

	const label = document.createElement("label");
	label.textContent = "Never auto-capture clipboard from (one app name per line)";
	row.appendChild(label);

	const textarea = document.createElement("textarea");
	textarea.className = "excluded-apps-textarea";
	textarea.value = current.excluded_apps.join("\n");
	textarea.onblur = async () => {
		const next = {
			...current,
			excluded_apps: textarea.value
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean),
		};
		settings = next;
		await Store.setSettings(next);
	};
	row.appendChild(textarea);

	return row;
}

/** Both default off: this app is meant to be summoned purely via the double-shift gesture / fallback shortcuts, not alt-tabbed to or clicked on. */
function buildVisibilityRows(current: Settings): HTMLElement[] {
	return [
		buildCheckboxRow("Show in Dock", current.show_in_dock, false, (checked) => ({ show_in_dock: checked })),
		buildCheckboxRow("Show in menu bar", current.show_tray_icon, false, (checked) => ({ show_tray_icon: checked })),
	];
}

function eventToAccelerator(e: KeyboardEvent): string | null {
	if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return null;
	const parts: string[] = [];
	if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
	if (e.shiftKey) parts.push("Shift");
	if (e.altKey) parts.push("Alt");
	const keyNames: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
	parts.push(keyNames[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
	if (parts.length < 2) return null; // require at least one modifier
	return parts.join("+");
}

function formatAccelerator(accel: string): string {
	if (!accel) return "Not set";
	return accel.replaceAll("CmdOrCtrl", "⌘").replaceAll("Shift", "⇧").replaceAll("Alt", "⌥").replaceAll("+", " ");
}

type FallbackShortcutKey = "fallback_toggle" | "fallback_capture" | "fallback_image";

const DEFAULT_FALLBACK: Record<FallbackShortcutKey, string> = {
	fallback_toggle: "CmdOrCtrl+Shift+Space",
	fallback_capture: "CmdOrCtrl+Shift+C",
	fallback_image: "CmdOrCtrl+Shift+I",
};

function buildShortcutRow(label: string, key: FallbackShortcutKey, current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = label;
	row.appendChild(name);

	const button = document.createElement("button");
	button.className = "shortcut-recorder";
	button.textContent = formatAccelerator(current[key]);
	const save = async (accel: string): Promise<void> => {
		const next = { ...current, [key]: accel };
		try {
			await Store.setSettings(next);
			settings = next;
			button.textContent = formatAccelerator(accel);
		} catch {
			button.textContent = formatAccelerator(current[key]);
		}
	};
	button.onclick = () => {
		button.textContent = "Press a shortcut…";
		const onKeydown = async (e: KeyboardEvent): Promise<void> => {
			e.preventDefault();
			e.stopPropagation();
			const accel = eventToAccelerator(e);
			window.removeEventListener("keydown", onKeydown, true);
			await save(accel ?? current[key]);
		};
		window.addEventListener("keydown", onKeydown, true);
	};
	row.appendChild(button);

	const clear = document.createElement("button");
	clear.className = "shortcut-clear";
	clear.textContent = "×";
	clear.title = "Disable this shortcut";
	clear.onclick = () => void save("");
	row.appendChild(clear);

	return row;
}

function buildResetShortcutsRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const button = document.createElement("button");
	button.textContent = "Reset fallback shortcuts to defaults";
	button.onclick = async () => {
		const next = { ...current, ...DEFAULT_FALLBACK };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(button);
	return row;
}

function buildTemplateRow(template: Template): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row template-row";

	const nameInput = document.createElement("input");
	nameInput.className = "template-name-input";
	nameInput.value = template.name;
	row.appendChild(nameInput);

	const bodyInput = document.createElement("input");
	bodyInput.className = "template-body-input";
	bodyInput.value = template.body;
	row.appendChild(bodyInput);

	const save = (): void => {
		const name = nameInput.value.trim();
		const body = bodyInput.value.trim();
		if (!name || !body) return;
		void Store.updateTemplate(template.id, name, body);
	};
	nameInput.onchange = save;
	bodyInput.onchange = save;

	const remove = document.createElement("button");
	remove.className = "template-delete";
	remove.textContent = "Delete";
	remove.onclick = async () => {
		await Store.deleteTemplate(template.id);
		await openSettings();
	};
	row.appendChild(remove);

	return row;
}

function buildAddTemplateForm(): HTMLElement {
	const form = document.createElement("div");
	form.className = "settings-row template-form";

	const nameInput = document.createElement("input");
	nameInput.placeholder = "name (e.g. standup)";
	form.appendChild(nameInput);

	const bodyInput = document.createElement("input");
	bodyInput.placeholder = "body, use {{var}} for args";
	form.appendChild(bodyInput);

	const add = document.createElement("button");
	add.textContent = "Add snippet";
	add.onclick = async () => {
		const name = nameInput.value.trim();
		const body = bodyInput.value.trim();
		if (!name || !body) return;
		await Store.addTemplate(name, body);
		await openSettings();
	};
	form.appendChild(add);

	return form;
}

function buildExportRow(): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const button = document.createElement("button");
	button.textContent = "Export as Markdown";
	button.onclick = async () => {
		const path = await Store.exportMarkdown();
		await open(path);
	};
	row.appendChild(button);

	return row;
}

function buildCaptureImageRow(): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const label = document.createElement("label");
	label.textContent = "Save the image currently on the clipboard";
	row.appendChild(label);

	const button = document.createElement("button");
	button.textContent = "Capture image";
	button.onclick = async () => {
		try {
			const item = await Store.captureClipboardImage();
			pushUndo({ type: "add", item });
			await openSettings();
		} catch (e) {
			button.textContent = String(e);
			setTimeout(() => (button.textContent = "Capture image"), 2000);
		}
	};
	row.appendChild(button);

	return row;
}

function formatHistoryTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

async function buildHistorySection(): Promise<HTMLElement> {
	const wrapper = document.createElement("div");
	const entries = await Store.listHistory(50);
	if (entries.length === 0) {
		const empty = document.createElement("div");
		empty.className = "settings-row history-row";
		empty.textContent = "Nothing yet.";
		wrapper.appendChild(empty);
		return wrapper;
	}
	for (const entry of entries) {
		const row = document.createElement("div");
		row.className = "settings-row history-row";
		const time = document.createElement("span");
		time.className = "history-time";
		time.textContent = formatHistoryTime(entry.at);
		row.appendChild(time);
		const detail = document.createElement("span");
		detail.className = "history-detail";
		detail.textContent = entry.detail ? `${entry.action}: ${entry.detail}` : entry.action;
		row.appendChild(detail);
		wrapper.appendChild(row);
	}
	return wrapper;
}

function buildSyncRows(current: Settings): HTMLElement[] {
	const backendRow = document.createElement("div");
	backendRow.className = "settings-row";
	const backendLabel = document.createElement("label");
	backendLabel.textContent = "Storage backend (restart required)";
	backendRow.appendChild(backendLabel);
	const backendSelect = document.createElement("select");
	backendSelect.dataset.focusAnchor = "backend-select";
	const backendLabels: Record<Settings["backend"], string> = {
		local: "Local (this device only)",
		s3: "S3-compatible bucket",
		folder: "Folder (e.g. iCloud Drive, Dropbox)",
	};
	for (const value of ["local", "s3", "folder"] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = backendLabels[value];
		option.selected = current.backend === value;
		backendSelect.appendChild(option);
	}
	backendSelect.onchange = async () => {
		const next = { ...current, backend: backendSelect.value as Settings["backend"] };
		settings = next;
		await Store.setSettings(next);
		refreshSyncRowsContainer(next);
	};
	backendRow.appendChild(backendSelect);

	const rows = [backendRow];
	if (current.backend === "s3") {
		const fields: Array<[keyof S3Settings, string, boolean]> = [
			["endpoint", "Endpoint (e.g. https://s3.us-east-1.amazonaws.com)", false],
			["bucket", "Bucket", false],
			["region", "Region", false],
			["access_key_id", "Access key ID", false],
			["secret_access_key", "Secret access key", true],
			["prefix", "Key prefix (optional)", false],
		];
		for (const [field, label, isSecret] of fields) {
			const row = document.createElement("div");
			row.className = "settings-row";
			const labelEl = document.createElement("label");
			labelEl.textContent = label;
			row.appendChild(labelEl);
			const fieldInput = document.createElement("input");
			fieldInput.type = isSecret ? "password" : "text";
			fieldInput.value = current.s3[field];
			fieldInput.onchange = async () => {
				const next = { ...current, s3: { ...current.s3, [field]: fieldInput.value } };
				settings = next;
				await Store.setSettings(next);
			};
			row.appendChild(fieldInput);
			rows.push(row);
		}
	}
	if (current.backend === "folder") {
		const row = document.createElement("div");
		row.className = "settings-row";
		const labelEl = document.createElement("label");
		labelEl.textContent = "Folder path";
		row.appendChild(labelEl);
		const pathInput = document.createElement("input");
		pathInput.type = "text";
		pathInput.placeholder = "~/Library/Mobile Documents/com~apple~CloudDocs/shiftshift";
		pathInput.value = current.folder_path;
		pathInput.onchange = async () => {
			const next = { ...current, folder_path: pathInput.value };
			settings = next;
			await Store.setSettings(next);
		};
		row.appendChild(pathInput);
		rows.push(row);

		// The friendliest sync option for a non-technical user: no account
		// setup, no API keys — just a folder inside iCloud Drive, which is
		// already syncing on every Mac signed into iCloud. `~` is expanded
		// backend-side (see `store/folder.rs::expand_tilde`), so this can
		// just be the literal path string.
		const icloudRow = document.createElement("div");
		icloudRow.className = "settings-row";
		const icloudLabel = document.createElement("label");
		icloudLabel.textContent = "Already signed into iCloud? One click, no setup:";
		icloudRow.appendChild(icloudLabel);
		const icloudBtn = document.createElement("button");
		icloudBtn.textContent = "Use iCloud Drive";
		icloudBtn.onclick = async () => {
			const next = { ...current, folder_path: "~/Library/Mobile Documents/com~apple~CloudDocs/shiftshift" };
			settings = next;
			await Store.setSettings(next);
			await openSettings();
		};
		icloudRow.appendChild(icloudBtn);
		rows.push(icloudRow);
	}
	return rows;
}

/** Rebuilds just the sync-backend rows (not the whole settings page) so switching "local"/"s3" via the select's own arrow keys doesn't steal focus off it — see `buildSyncRows`'s `backendSelect`. */
function refreshSyncRowsContainer(current: Settings): void {
	const container = document.getElementById("sync-rows-container");
	if (!container) return;
	container.innerHTML = "";
	for (const row of buildSyncRows(current)) container.appendChild(row);
	container.querySelector<HTMLSelectElement>('[data-focus-anchor="backend-select"]')?.focus();
}

function computedThemeColors(): ThemeColors {
	const style = getComputedStyle(document.documentElement);
	const get = (name: string): string => style.getPropertyValue(name).trim();
	return {
		bg: get("--bg"),
		fg: get("--fg"),
		muted: get("--muted"),
		row_bg: get("--row-bg"),
		accent: get("--accent"),
		accent_fg: get("--accent-fg"),
		border: get("--border"),
	};
}

const COLOR_FIELD_LABELS: Array<[string, keyof ThemeColors]> = [
	["Background", "bg"],
	["Text", "fg"],
	["Muted text", "muted"],
	["Row background", "row_bg"],
	["Accent", "accent"],
	["Accent text", "accent_fg"],
	["Border", "border"],
];

function buildCustomThemeForm(editing: CustomTheme | null, onSaved: () => Promise<void>): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "custom-theme-form";

	const heading = document.createElement("div");
	heading.className = "custom-theme-form-title";
	heading.textContent = editing ? `Editing "${editing.name}"` : "New custom theme";
	wrapper.appendChild(heading);

	const nameRow = document.createElement("div");
	nameRow.className = "settings-row";
	const nameInput = document.createElement("input");
	nameInput.placeholder = "Theme name";
	nameInput.value = editing?.name ?? "";
	nameRow.appendChild(nameInput);
	const modeSelect = document.createElement("select");
	for (const m of ["dark", "light"] as const) {
		const opt = document.createElement("option");
		opt.value = m;
		opt.textContent = m === "dark" ? "Dark" : "Light";
		opt.selected = (editing?.mode ?? "dark") === m;
		modeSelect.appendChild(opt);
	}
	nameRow.appendChild(modeSelect);
	wrapper.appendChild(nameRow);

	const colors: ThemeColors = editing ? { ...editing.colors } : computedThemeColors();
	const colorFields = document.createElement("div");
	colorFields.className = "color-fields";
	for (const [label, key] of COLOR_FIELD_LABELS) {
		const field = document.createElement("div");
		field.className = "color-field";
		const fieldLabel = document.createElement("label");
		fieldLabel.textContent = label;
		field.appendChild(fieldLabel);
		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.value = colors[key];
		colorInput.oninput = () => {
			colors[key] = colorInput.value;
		};
		field.appendChild(colorInput);
		colorFields.appendChild(field);
	}
	wrapper.appendChild(colorFields);

	const saveBtn = document.createElement("button");
	saveBtn.textContent = editing ? "Update theme" : "Save as new theme";
	saveBtn.onclick = async () => {
		const name = nameInput.value.trim();
		if (!name) return;
		const mode = modeSelect.value as "light" | "dark";
		if (editing) await Store.updateCustomTheme(editing.id, name, mode, colors);
		else await Store.addCustomTheme(name, mode, colors);
		await onSaved();
	};
	wrapper.appendChild(saveBtn);

	return wrapper;
}

function buildCustomThemeRow(theme: CustomTheme, onEdit: () => void, onDeleted: () => Promise<void>): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row template-row";

	const label = document.createElement("span");
	label.textContent = `${theme.name} (${theme.mode})`;
	row.appendChild(label);

	const useBtn = document.createElement("button");
	useBtn.textContent = "Use";
	useBtn.onclick = () => void setTheme(theme.id);
	row.appendChild(useBtn);

	const editBtn = document.createElement("button");
	editBtn.textContent = "Edit";
	editBtn.onclick = onEdit;
	row.appendChild(editBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "template-delete";
	deleteBtn.textContent = "Delete";
	deleteBtn.onclick = async () => {
		await Store.deleteCustomTheme(theme.id);
		await onDeleted();
	};
	row.appendChild(deleteBtn);

	return row;
}

/** Self-contained widget: rebuilds its own children on every mutation (create/edit/delete/import), so editing state doesn't need to live outside this function. */
function renderCustomThemesSection(container: HTMLElement, themes: CustomTheme[], editingId: string | null): void {
	container.innerHTML = "";
	const refresh = async (nextEditingId: string | null): Promise<void> => {
		customThemesCache = await Store.listCustomThemes();
		renderCustomThemesSection(container, customThemesCache, nextEditingId);
	};

	for (const theme of themes) {
		container.appendChild(buildCustomThemeRow(theme, () => void refresh(theme.id), () => refresh(null)));
	}

	const editing = themes.find((t) => t.id === editingId) ?? null;
	container.appendChild(buildCustomThemeForm(editing, () => refresh(null)));

	const ioRow = document.createElement("div");
	ioRow.className = "settings-row";

	const exportBtn = document.createElement("button");
	exportBtn.textContent = "Export to clipboard";
	exportBtn.onclick = async () => {
		const payload = customThemesCache.map((t) => ({ name: t.name, mode: t.mode, colors: t.colors }));
		await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
		exportBtn.textContent = "Copied!";
		setTimeout(() => (exportBtn.textContent = "Export to clipboard"), 1500);
	};
	ioRow.appendChild(exportBtn);

	const importBtn = document.createElement("button");
	importBtn.textContent = "Import from clipboard";
	importBtn.onclick = async () => {
		try {
			const raw = await navigator.clipboard.readText();
			const parsed: unknown = JSON.parse(raw);
			const entries = Array.isArray(parsed) ? parsed : [parsed];
			let imported = 0;
			for (const entry of entries) {
				if (!isImportableTheme(entry)) continue;
				await Store.addCustomTheme(entry.name, entry.mode, entry.colors);
				imported++;
			}
			importBtn.textContent = imported > 0 ? `Imported ${imported}` : "Nothing valid found";
			setTimeout(() => (importBtn.textContent = "Import from clipboard"), 1500);
			await refresh(null);
		} catch {
			importBtn.textContent = "Invalid clipboard content";
			setTimeout(() => (importBtn.textContent = "Import from clipboard"), 1500);
		}
	};
	ioRow.appendChild(importBtn);
	container.appendChild(ioRow);
}

function sectionId(text: string): string {
	return `settings-section-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function heading(text: string): HTMLElement {
	const h = document.createElement("h3");
	h.textContent = text;
	h.id = sectionId(text);
	return h;
}

/** [visible label, exact heading text to jump to] — a short list of the sections worth a quick jump, not every single one. */
const SETTINGS_NAV: Array<[string, string]> = [
	["Appearance", "Appearance"],
	["Capture", "Capture behavior"],
	["Pins", "Pinned quick-access"],
	["Shortcuts", "Double-shift bindings"],
	["Notifications", "Notifications"],
	["Templates", "Snippet templates"],
	["Sync", "Sync"],
	["History", "History"],
];

function buildSettingsNav(): HTMLElement {
	const nav = document.createElement("div");
	nav.className = "settings-nav";
	for (const [label, target] of SETTINGS_NAV) {
		const btn = document.createElement("button");
		btn.className = "settings-nav-btn";
		btn.textContent = label;
		btn.onclick = () => document.getElementById(sectionId(target))?.scrollIntoView({ block: "start", behavior: "smooth" });
		nav.appendChild(btn);
	}
	return nav;
}

function buildSyncStatusRow(status: SyncStatus): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row sync-status-row";
	const backendLabels: Record<SyncStatus["active_backend"], string> = { local: "Local", s3: "S3", folder: "Folder" };
	const label = document.createElement("span");
	if (status.fallback_reason) {
		label.textContent = `⚠️ Using ${backendLabels[status.active_backend]} — ${status.fallback_reason}`;
		row.classList.add("sync-status-warning");
	} else {
		label.textContent = `✓ Active: ${backendLabels[status.active_backend]}`;
	}
	row.appendChild(label);
	return row;
}

async function openSettings(): Promise<void> {
	const [current, templates, historySection, syncStatus] = await Promise.all([
		loadSettings(),
		Store.listTemplates(),
		buildHistorySection(),
		Store.getSyncStatus(),
	]);
	settingsView.innerHTML = "";
	settingsView.appendChild(buildSettingsNav());

	settingsView.appendChild(heading("Appearance"));
	settingsView.appendChild(buildThemeRow(current));
	settingsView.appendChild(buildOpacityRow(current));

	const customThemesDetails = document.createElement("details");
	customThemesDetails.className = "settings-collapsible";
	const customThemesSummary = document.createElement("summary");
	customThemesSummary.id = sectionId("Custom themes");
	customThemesSummary.textContent = "Custom themes";
	customThemesDetails.appendChild(customThemesSummary);
	const customThemesSection = document.createElement("div");
	renderCustomThemesSection(customThemesSection, customThemesCache, null);
	customThemesDetails.appendChild(customThemesSection);
	settingsView.appendChild(customThemesDetails);

	settingsView.appendChild(heading("Capture behavior"));
	settingsView.appendChild(buildCaptureModeRow(current));
	settingsView.appendChild(buildSortRow(current));
	for (const row of buildBehaviorRows(current)) settingsView.appendChild(row);
	settingsView.appendChild(buildExcludedAppsRow(current));

	settingsView.appendChild(heading("Pinned quick-access"));
	settingsView.appendChild(buildPinnedItemsSection(current));

	settingsView.appendChild(heading("Visibility"));
	for (const row of buildVisibilityRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Double-shift bindings"));
	settingsView.appendChild(buildBindingRow("Left Shift", "left", current));
	settingsView.appendChild(buildBindingRow("Right Shift", "right", current));

	settingsView.appendChild(heading("Fallback shortcuts"));
	settingsView.appendChild(buildShortcutRow("Toggle panel", "fallback_toggle", current));
	settingsView.appendChild(buildShortcutRow("Capture selection", "fallback_capture", current));
	settingsView.appendChild(buildShortcutRow("Capture image", "fallback_image", current));
	settingsView.appendChild(buildResetShortcutsRow(current));

	settingsView.appendChild(heading("Notifications"));
	for (const row of buildNotificationRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Images"));
	settingsView.appendChild(buildCaptureImageRow());

	settingsView.appendChild(heading("Snippet templates"));
	for (const template of templates) {
		settingsView.appendChild(buildTemplateRow(template));
	}
	settingsView.appendChild(buildAddTemplateForm());

	settingsView.appendChild(heading("Sync"));
	settingsView.appendChild(buildSyncStatusRow(syncStatus));
	const syncContainer = document.createElement("div");
	syncContainer.id = "sync-rows-container";
	for (const row of buildSyncRows(current)) syncContainer.appendChild(row);
	settingsView.appendChild(syncContainer);
	settingsView.appendChild(
		buildCheckboxRow(
			"Encrypt local database at rest (restart required)",
			current.encrypt_local_storage,
			false,
			(checked) => ({ encrypt_local_storage: checked }),
		),
	);

	settingsView.appendChild(heading("Export"));
	settingsView.appendChild(buildExportRow());

	settingsView.appendChild(heading("History"));
	settingsView.appendChild(historySection);

	const back = document.createElement("button");
	back.className = "settings-back";
	back.textContent = "Back";
	back.onclick = () => closeSettings();
	settingsView.appendChild(back);

	settingsView.hidden = false;
	list.hidden = true;
	metaBar.hidden = true;
	detailView.hidden = true;
	settingsBtn.textContent = "✕";
}

function closeSettings(): void {
	settingsView.hidden = true;
	list.hidden = false;
	settingsBtn.textContent = "⚙";
	input.focus();
}

settingsBtn.onclick = () => {
	if (settingsView.hidden) void openSettings();
	else closeSettings();
};

void loadSettings();
void refresh();

// A misconfigured S3/folder backend used to fail completely silently — an
// eprintln! to a terminal nobody's watching, with the UI just quietly using
// local storage forever with no explanation. Surface it once at startup.
void Store.getSyncStatus().then((status) => {
	if (status.fallback_reason) {
		showStatusToast(`Using local storage: ${status.fallback_reason}`, 6000);
	}
});
