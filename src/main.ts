import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import {
	applySort,
	extractTags,
	filterItems,
	findDuplicate,
	formatRelativeTime,
	isImportableTheme,
	normalizeThemeColors,
	emptyTabCopy,
	extendRangeByIds,
	itemsForTab,
	lastToken,
	LIST_TABS,
	nextListTab,
	normalizeTagInput,
	matchAtSuggestions,
	matchHashSuggestions,
	matchHelpEntries,
	matchSlashSuggestions,
	matchSortSuggestions,
	matchThemeSuggestions,
	parseInlineMarkdown,
	parseSlashMode,
	parseUiCommand,
	rankForDrop,
	applyListDrag,
	listDragNeedsSyntheticDown,
	listDragRowFromPoint,
	pointerLeftWindow,
	replaceLastToken,
	resolveCapture,
	slashSuggestionIsImmediate,
	settingsSearchMatches,
	SORT_OPTIONS,
	type ListTab,
	type MatchedHelpEntry,
	type SlashMode,
	type SlashSuggestion,
	type ThemeChoice,
} from "./capture-logic";
import {
	buildHoverActions,
	formatHeaderCount,
	itemContextEntries,
	nextNotchLoadedCount,
	NOTCH_PAGE_SIZE,
	notchShouldLoadMore,
	openCommandPalette,
	openItemContextMenu,
	pointerOnScrollbar,
	stepLoadedSelection,
} from "./item-chrome";
import {
	Store,
	SYSTEM_SOUNDS,
	type Action,
	type CaptureMode,
	type CustomTheme,
	type HighlightSubmit,
	type HistoryEntry,
	type Item,
	type ItemKind,
	type LinkPreview,
	type MoveDirection,
	type NotificationStyle,
	type NotifyContent,
	type S3Settings,
	type Settings,
	type SortMode,
	type SyncStatus,
	type Template,
	type ThemeColors,
	type ToastPosition,
} from "./store";
import { applyCustomPalette, clearCustomPalette, normalizeTheme, THEMES } from "./themes";

const app = document.getElementById("app")!;

const panelDrag = document.createElement("div");
panelDrag.className = "panel-drag";
panelDrag.title = "Drag to move";
panelDrag.setAttribute("data-tauri-drag-region", "");
app.appendChild(panelDrag);
const panelHead = document.createElement("div");
panelHead.className = "panel-head";
panelHead.setAttribute("data-tauri-drag-region", "");
const tabsEl = document.createElement("div");
tabsEl.className = "notch-tabs";
tabsEl.role = "tablist";
panelHead.appendChild(tabsEl);
const headerCount = document.createElement("span");
headerCount.className = "panel-header-count";
panelHead.appendChild(headerCount);
app.appendChild(panelHead);

for (const tab of LIST_TABS) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.role = "tab";
	btn.className = "notch-tab";
	btn.dataset.tab = tab.id;
	btn.textContent = tab.label;
	btn.addEventListener("click", () => {
		if (currentTab === tab.id) return;
		setListTab(tab.id);
	});
	tabsEl.appendChild(btn);
}

const captureRow = document.createElement("div");
captureRow.className = "capture-row";
app.appendChild(captureRow);

const input = document.createElement("input");
input.className = "capture-input";
input.placeholder = "Capture anything…   / for commands   @ to filter";
input.autocomplete = "off";
input.spellcheck = false;
input.setAttribute("autocorrect", "off");
input.setAttribute("autocapitalize", "off");
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
settingsBtn.title = "Settings";
settingsBtn.setAttribute("aria-label", "Settings");
settingsBtn.innerHTML =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/></svg>';
captureRow.appendChild(settingsBtn);

const duplicateHint = document.createElement("div");
duplicateHint.className = "duplicate-hint";
duplicateHint.hidden = true;
duplicateHint.textContent = "Already saved — Enter adds it again";
app.appendChild(duplicateHint);

// First-run/ongoing guide: double-Shift capture needs Accessibility access
// on macOS (a no-op check on other platforms, see accessibility_trusted) —
// walks the user to the right System Settings pane instead of leaving them
// to discover the permission themselves, cooper-style. Re-checks on an
// interval so it clears itself the moment the box gets ticked — macOS
// applies that instantly, no relaunch needed.
const permissionBanner = document.createElement("div");
permissionBanner.className = "permission-banner";
permissionBanner.hidden = true;
const permissionText = document.createElement("span");
permissionText.textContent = "Double-Shift capture is inactive — grant Accessibility access to enable it.";
permissionBanner.appendChild(permissionText);
const permissionBtn = document.createElement("button");
permissionBtn.textContent = "Open Settings";
permissionBtn.onclick = () => void Store.openAccessibilitySettings();
permissionBanner.appendChild(permissionBtn);
app.appendChild(permissionBanner);

let permissionCheckTimer: ReturnType<typeof setInterval> | undefined;
async function checkAccessibilityPermission(): Promise<void> {
	const trusted = await Store.accessibilityTrusted();
	permissionBanner.hidden = trusted;
	if (trusted) {
		clearInterval(permissionCheckTimer);
		permissionCheckTimer = undefined;
	} else if (!permissionCheckTimer) {
		permissionCheckTimer = setInterval(checkAccessibilityPermission, 5000);
	}
}
window.setTimeout(() => void checkAccessibilityPermission(), 800);

const list = document.createElement("div");
list.className = "item-list";
list.addEventListener("scroll", () => {
	if (!notchShouldLoadMore(list.scrollTop, list.clientHeight, list.scrollHeight, listLoadedCount, filtered.length)) {
		return;
	}
	listLoadedCount = nextNotchLoadedCount(listLoadedCount, filtered.length);
	renderList();
});
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
let currentTab: ListTab = "recent";
let listLoadedCount = NOTCH_PAGE_SIZE;
let listFilterKey = "";
let templatesCache: Template[] = [];
let customThemesCache: CustomTheme[] = [];
let selected = -1;
let settings: Settings | null = null;
/** Built up with Shift+↑/↓ (range) or Space (toggle); plain Enter copies them as a numbered list and closes. */
const multiSelected = new Set<string>();
/** Sticky end of a Shift+arrow range — walking back toward it unselects. */
let selectionAnchorId: string | null = null;
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
let listDragging = false;
let pointerReorder: { id: string; from: number; over: number; x: number; y: number; live: boolean } | null = null;

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
	await applyHighlightSubmit(item.kind === "link");
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
		applyCustomPalette(root, normalizeThemeColors(custom.colors), custom.mode);
	} else {
		clearCustomPalette(root);
		root.dataset.theme = normalizeTheme(themeId);
	}
	// `panel_opacity` (Settings → Appearance) overrides whatever the theme
	// itself set for `--bg-alpha` — an independent "how see-through is the
	// panel" control, not tied to any one theme. 0 means "no override".
	if (settings && settings.panel_opacity > 0) {
		root.style.setProperty("--bg-alpha", `${settings.panel_opacity}%`);
	}
}

function applyInputSpellcheck(enabled: boolean): void {
	input.spellcheck = enabled;
	input.autocomplete = "off";
	input.setAttribute("autocorrect", enabled ? "on" : "off");
	input.setAttribute("autocapitalize", enabled ? "sentences" : "off");
}

async function loadSettings(): Promise<Settings> {
	const first = !settings;
	settings = await Store.getSettings();
	if (first) {
		customThemesCache = await Store.listCustomThemes();
		applyTheme(settings.theme);
		applyInputSpellcheck(settings.input_spellcheck);
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
	return applySort(filterItems(itemsForTab(items, currentTab), input.value), settings?.sort_mode ?? "manual");
}

function paintListTabs(): void {
	for (const btn of tabsEl.querySelectorAll<HTMLButtonElement>(".notch-tab")) {
		btn.setAttribute("aria-selected", String(btn.dataset.tab === currentTab));
	}
}

function setListTab(tab: ListTab): void {
	currentTab = tab;
	selected = -1;
	listLoadedCount = NOTCH_PAGE_SIZE;
	listFilterKey = "";
	multiSelected.clear();
	selectionAnchorId = null;
	paintListTabs();
	renderList();
}

function cycleListTab(delta: number): void {
	setListTab(nextListTab(currentTab, delta));
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
		duplicateHint.textContent = `${multiSelected.size} selected — Enter copies numbered, ⌘C copies lines, ⌃Space toggles`;
		return;
	}
	duplicateHint.textContent = "Already saved — Enter adds it again";
	const query = input.value;
	const duplicate = !query.startsWith("/") && findDuplicate(items, query);
	duplicateHint.hidden = !duplicate;
}

const CONTENT_TYPE_LABELS: Record<ItemKind, string> = { note: "Text", todo: "Todo", link: "Link", image: "Image" };

/** Shown in the footer the instant the matching modifier is held, so the
 * shortcuts it unlocks don't have to be memorized — see `updateHeldModifier`. */
const MODIFIER_HINTS: Partial<Record<string, string>> = {
	Shift: "⇧↑ / ⇧↓ range · ⇧Enter save + copy · ⇧→ details",
	Alt: "⌥↑ / ⌥↓ reorder · ⌥-click an image to open in Preview",
	Meta: "⌘Enter force-saves typed text and stays open — does not copy",
	Control: "⌃Space toggle this row in or out, without moving",
};
let heldModifierHint: string | null = null;

function updateHeldModifier(e: KeyboardEvent): void {
	const hint = MODIFIER_HINTS[e.key];
	if (hint === undefined) return;
	heldModifierHint = e.type === "keydown" ? hint : null;
	updateMetaBar();
}
document.addEventListener("keydown", updateHeldModifier);
document.addEventListener("keyup", updateHeldModifier);

function updateMetaBar(): void {
	if (!settingsView.hidden || !detailView.hidden) {
		metaBar.hidden = true;
		return;
	}
	if (heldModifierHint !== null && settingsView.hidden && detailView.hidden) {
		metaBar.textContent = heldModifierHint;
		metaBar.hidden = false;
		return;
	}
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
	if (item.kind === "image") parts.push("⌥-click Preview");
	metaBar.textContent = parts.join("   ·   ");
	metaBar.hidden = false;
}

function showImagePreview(path: string): void {
	void Store.previewFile(path);
}

function buildEmptyState(neverCaptured: boolean): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "empty-state";
	if (neverCaptured) {
		wrapper.textContent = "Nothing captured yet — double-tap Shift, or type here and press ⌘Enter. Type /help for shortcuts.";
		return wrapper;
	}
	const copy = emptyTabCopy(currentTab, input.value.trim().length > 0);
	wrapper.textContent = `${copy.title} — ${copy.body}`;
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
	if (raw !== listFilterKey) {
		listFilterKey = raw;
		listLoadedCount = NOTCH_PAGE_SIZE;
	}
	if (selected >= listLoadedCount && selected >= 0) {
		listLoadedCount = selected + 1;
	}
	listLoadedCount = Math.min(Math.max(listLoadedCount, 0), filtered.length);
	if (filtered.length > 0) {
		listLoadedCount = Math.max(listLoadedCount, Math.min(NOTCH_PAGE_SIZE, filtered.length));
	}
	const visible = filtered.slice(0, listLoadedCount);
	const scrollTop = list.scrollTop;
	list.innerHTML = "";
	if (visible.length === 0) {
		list.appendChild(buildEmptyState(items.length === 0));
	}
	visible.forEach((item, index) => {
		list.appendChild(buildRow(item, index));
	});
	list.scrollTop = scrollTop;
	headerCount.textContent = formatHeaderCount(filtered.length);
	paintListTabs();
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
		renderHelpRows(mode.query);
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

function renderHelpRows(query: string): void {
	lastHelpCategory = "";
	const entries = matchHelpEntries(query);
	if (entries.length === 0) {
		const empty = document.createElement("div");
		empty.className = "item-row";
		empty.textContent = "No matching shortcuts.";
		list.appendChild(empty);
		duplicateHint.hidden = true;
		metaBar.hidden = true;
		return;
	}
	for (const entry of entries) list.appendChild(buildHelpRow(entry));
	duplicateHint.hidden = true;
	metaBar.hidden = true;
}

function buildHelpRow(entry: MatchedHelpEntry): HTMLElement {
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
	appendHighlighted(description, entry.description, entry.descriptionRanges);
	row.appendChild(description);
	return row;
}

/** Renders `text` into `parent`, wrapping the [start, end) ranges (from a fuzzy match) in a highlight span. */
function appendHighlighted(parent: HTMLElement, text: string, ranges: Array<[number, number]>): void {
	if (ranges.length === 0) {
		parent.textContent = text;
		return;
	}
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, start)));
		const mark = document.createElement("mark");
		mark.className = "fuzzy-match";
		mark.textContent = text.slice(start, end);
		parent.appendChild(mark);
		cursor = end;
	}
	if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
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
	input.value = replaceLastToken(input.value, `@${tag}`);
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
	input.value = replaceLastToken(input.value, `#${tag}`);
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
	row.dataset.kind = item.kind;
	row.dataset.dragIndex = String(index);
	row.dataset.id = item.id;
	row.classList.toggle("selected", index === selected);
	row.classList.toggle("multi-selected", multiSelected.has(item.id));
	row.onclick = (e) => {
		if (listDragging) return;
		if (e.altKey && item.kind === "image") {
			e.preventDefault();
			showImagePreview(item.text);
			return;
		}
		selected = index;
		if (e.shiftKey || e.metaKey || e.ctrlKey) {
			e.preventDefault();
			if (multiSelected.has(item.id)) multiSelected.delete(item.id);
			else multiSelected.add(item.id);
			selectionAnchorId = item.id;
		}
		renderList();
	};

	if (item.kind === "todo") {
		row.appendChild(buildIcon(item));
	}

	if (editingId === item.id) {
		row.appendChild(buildEditInput(item));
	} else if (item.kind === "image") {
		const thumb = document.createElement("img");
		thumb.className = "item-thumb";
		thumb.draggable = false;
		thumb.src = convertFileSrc(item.text);
		thumb.onclick = (e) => {
			e.stopPropagation();
			if (listDragging) return;
			if (e.altKey) {
				e.preventDefault();
				showImagePreview(item.text);
				return;
			}
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
			if (listDragging) return;
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

	row.appendChild(
		buildHoverActions(
			item,
			(id) => {
				void runItemChromeAction(item, id);
			},
			() => listDragging,
		),
	);
	row.addEventListener("contextmenu", (e) => {
		openItemContextMenu(
			e,
			itemContextEntries(item, { inSelection: multiSelected.has(item.id), selectionCount: multiSelected.size }),
			(id) => {
				void runItemChromeAction(item, id);
			},
		);
	});

	if (editingId !== item.id) {
		row.addEventListener(
			"pointerdown",
			(e) => {
				if (e.button !== 0 || e.altKey) return;
				if (pointerOnScrollbar(list, e.clientX)) return;
				if (e.target instanceof Element && e.target.closest(".item-check, .item-edit-input, .item-actions"))
					return;
				pointerReorder = applyListDrag(null, { type: "down", id: item.id, index, x: e.clientX, y: e.clientY }).state;
				try {
					row.setPointerCapture(e.pointerId);
				} catch {
					/* unfocused / non-focusable window */
				}
			},
			true,
		);
	}

	return row;
}

function beginExternalDrag(id: string): void {
	const current = items.find((item) => item.id === id);
	pointerReorder = null;
	clearReorderMarks();
	window.setTimeout(() => {
		listDragging = false;
	}, 0);
	if (current) void Store.startItemDrag(current.kind, current.text);
}

function clearReorderMarks(): void {
	for (const el of list.querySelectorAll(".is-drop-before, .is-drop-after, .is-dragging")) {
		el.classList.remove("is-drop-before", "is-drop-after", "is-dragging");
	}
}

function markReorderOver(overIndex: number): void {
	clearReorderMarks();
	const rows = [...list.querySelectorAll<HTMLElement>(".item-row[data-drag-index]")];
	const dragging = rows.find((el) => el.dataset.id === pointerReorder?.id);
	dragging?.classList.add("is-dragging");
	const target = rows.find((el) => Number(el.dataset.dragIndex) === overIndex);
	target?.classList.add(overIndex > (pointerReorder?.from ?? 0) ? "is-drop-after" : "is-drop-before");
}

window.addEventListener("pointermove", (e) => {
	if (!pointerReorder && listDragNeedsSyntheticDown(null, e.buttons)) {
		const under = document.elementFromPoint(e.clientX, e.clientY);
		if (pointerOnScrollbar(list, e.clientX)) {
			/* scrollbar */
		} else if (!(under instanceof Element && under.closest(".item-check, .item-edit-input"))) {
			const row = listDragRowFromPoint(e.clientX, e.clientY);
			const id = row?.dataset.id;
			const index = row ? Number(row.dataset.dragIndex) : Number.NaN;
			if (row && id && !Number.isNaN(index)) {
				pointerReorder = applyListDrag(null, { type: "down", id, index, x: e.clientX, y: e.clientY }).state;
				try {
					row.setPointerCapture(e.pointerId);
				} catch {
					/* unfocused / non-focusable window */
				}
			}
		}
	}
	if (!pointerReorder) return;
	const hit = listDragRowFromPoint(e.clientX, e.clientY);
	const overIndex = hit ? Number(hit.dataset.dragIndex) : pointerReorder.over;
	const next = applyListDrag(pointerReorder, {
		type: "move",
		x: e.clientX,
		y: e.clientY,
		overIndex,
		leftWindow: pointerLeftWindow(e.clientX, e.clientY, window.innerWidth, window.innerHeight),
	});
	pointerReorder = next.state;
	if (next.effect.type === "none") return;
	listDragging = true;
	if (next.effect.type === "external") {
		beginExternalDrag(next.effect.id);
		return;
	}
	if (next.effect.type === "reorder") markReorderOver(next.effect.overIndex);
});

document.addEventListener("pointerleave", () => {
	const next = applyListDrag(pointerReorder, { type: "leave" });
	pointerReorder = next.state;
	if (next.effect.type === "external") beginExternalDrag(next.effect.id);
});

window.addEventListener("pointercancel", (e) => {
	const left = pointerLeftWindow(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
	if (left || pointerReorder?.live) {
		const next = applyListDrag(pointerReorder, { type: "leave" });
		pointerReorder = next.state;
		if (next.effect.type === "external") beginExternalDrag(next.effect.id);
		return;
	}
	pointerReorder = null;
	clearReorderMarks();
	listDragging = false;
});

window.addEventListener("pointerup", () => {
	const next = applyListDrag(pointerReorder, { type: "up" });
	pointerReorder = next.state;
	clearReorderMarks();
	window.setTimeout(() => {
		listDragging = false;
	}, 0);
	if (next.effect.type !== "commit") return;
	const { id, from, over } = next.effect;
	const visible = computeFiltered();
	const rank = rankForDrop(visible, id, over > from ? over + 1 : over);
	void (async () => {
		await Store.setRank(id, rank);
		await refresh();
		const nextSelected = computeFiltered().findIndex((rowItem) => rowItem.id === id);
		if (nextSelected >= 0) selected = nextSelected;
		renderList();
	})();
});

list.addEventListener("selectstart", (e) => {
	if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
	e.preventDefault();
});

async function runItemChromeAction(item: Item, id: string): Promise<void> {
	if (id === "bookmark") {
		pushUndo({ type: "toggle_bookmarked", id: item.id });
		await Store.toggleBookmarked(item.id);
		await refresh();
		return;
	}
	if (id === "todo") {
		const to = item.kind === "todo" ? "note" : "todo";
		pushUndo({ type: "set_kind", id: item.id, from: item.kind, to });
		await Store.setKind(item.id, to);
		await refresh();
		return;
	}
	if (id === "edit") {
		startEditing(item.id);
		return;
	}
	if (id === "share") {
		await shareItem(item);
		return;
	}
	if (id === "delete") {
		pushUndo({ type: "delete", item });
		await Store.deleteItem(item.id);
		await refresh();
		showStatusToast("Deleted — ⌘Z to undo");
		return;
	}
	if (id === "select") {
		multiSelected.add(item.id);
		renderList();
		return;
	}
	if (id === "deselect") {
		multiSelected.delete(item.id);
		renderList();
		return;
	}
	if (id === "select_all") {
		for (const row of filtered) multiSelected.add(row.id);
		renderList();
		return;
	}
	if (id === "copy_selection") {
		await copyMultiSelectionAndClose();
		return;
	}
	if (id === "bookmark_selection") {
		await bulkToggleBookmark();
		return;
	}
	if (id === "todo_selection") {
		await bulkToggleTodo();
		return;
	}
	if (id === "delete_selection") {
		await bulkDelete();
		return;
	}
	if (id === "tag_selection") {
		await bulkAddTag();
	}
}

/** Leading icon slot: an interactive checkbox for todos only. */
function buildIcon(item: Item): HTMLElement {
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

/** After copying/opening a highlighted item: honor Settings -> "On Enter".
 * Links skip the paste step (opening is the action; writing a URL into
 * whatever you were typing is almost never what you wanted). */
async function applyHighlightSubmit(openedLink: boolean): Promise<void> {
	const mode: HighlightSubmit = settings?.highlight_submit ?? "copy_hide_write";
	if (mode === "copy") return;
	if (mode === "copy_hide" || openedLink) {
		await Store.hidePanel();
		return;
	}
	await Store.hidePanelAndPaste();
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

/** Copy the multi-selection. Enter-to-close stays numbered; ⌘C stays as plain lines. */
async function copyMultiSelection(close: boolean, style: "numbered" | "plain" = "numbered"): Promise<void> {
	const ordered = items.filter((item) => multiSelected.has(item.id));
	const joined =
		style === "plain"
			? ordered.map((item) => item.text).join("\n")
			: ordered.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
	await navigator.clipboard.writeText(joined);
	await Store.noteOwnClipboardWrite(joined);
	for (const item of ordered) await Store.logUsed(item.id);
	if (!close) return;
	multiSelected.clear();
	selectionAnchorId = null;
	await applyHighlightSubmit(false);
}

async function copyMultiSelectionAndClose(): Promise<void> {
	await copyMultiSelection(true);
}

/** Deletes every multi-selected item as one undoable action, then clears the selection. */
async function bulkDelete(): Promise<void> {
	const selected = items.filter((item) => multiSelected.has(item.id));
	if (selected.length === 0) return;
	for (const item of selected) await Store.deleteItem(item.id);
	pushUndo({ type: "bulk", entries: selected.map((item) => ({ type: "delete", item })) });
	multiSelected.clear();
	selectionAnchorId = null;
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

/** Appends the same `#tag` to every multi-selected item's text — the bulk counterpart of the detail view's single-item "Add a tag". */
async function bulkAddTag(): Promise<void> {
	const selected = items.filter((item) => multiSelected.has(item.id));
	if (selected.length === 0) return;
	const clean = normalizeTagInput(window.prompt(`Tag ${selected.length} item${selected.length === 1 ? "" : "s"} with:`) ?? "");
	if (!clean) return;
	const entries: UndoEntry[] = [];
	for (const item of selected) {
		const to = `${item.text} #${clean}`;
		await Store.updateItemText(item.id, to);
		entries.push({ type: "update_text", id: item.id, from: item.text, to });
	}
	pushUndo({ type: "bulk", entries });
	await refresh();
	showStatusToast(`Tagged ${selected.length} item${selected.length === 1 ? "" : "s"} with #${clean}`);
}

function formatAbsoluteTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function buildDetailTop(item: Item, editing: boolean): HTMLElement {
	const top = document.createElement("div");
	top.className = "detail-top";
	const back = document.createElement("button");
	back.className = "detail-back";
	back.textContent = "← Back";
	back.onclick = () => closeDetail();
	top.appendChild(back);
	const kicker = document.createElement("div");
	kicker.className = "detail-kicker";
	const bits = [CONTENT_TYPE_LABELS[item.kind], formatRelativeTime(item.created_at)];
	if (item.source_app) bits.push(`from ${item.source_app}`);
	if (item.bookmarked) bits.push("★");
	kicker.textContent = bits.join(" · ");
	top.appendChild(kicker);
	const actions = document.createElement("div");
	actions.className = "detail-top-actions";
	const copy = document.createElement("button");
	copy.className = "detail-edit-btn";
	copy.textContent = "Copy";
	copy.onclick = async () => {
		if (item.kind === "image") await Store.copyImageToClipboard(item.text);
		else {
			await navigator.clipboard.writeText(item.text);
			await Store.noteOwnClipboardWrite(item.text);
		}
		await Store.logUsed(item.id);
		showStatusToast("Copied");
	};
	actions.appendChild(copy);
	const pin = document.createElement("button");
	pin.className = "detail-edit-btn";
	pin.textContent = "Pin";
	pin.onclick = async () => {
		const current = await loadSettings();
		const already = current.pinned_items.findIndex((id) => id === item.id);
		if (already >= 0) {
			const next = { ...current, pinned_items: current.pinned_items.map((id, i) => (i === already ? "" : id)) };
			settings = next;
			await Store.setSettings(next);
			showStatusToast("Unpinned");
			pin.textContent = "Pin";
			return;
		}
		const empty = current.pinned_items.findIndex((id) => !id);
		const slot = empty >= 0 ? empty : 0;
		const next = { ...current, pinned_items: current.pinned_items.map((id, i) => (i === slot ? item.id : id)) };
		settings = next;
		await Store.setSettings(next);
		showStatusToast(`Pinned to ⌘${slot + 1}`);
		pin.textContent = "Unpin";
	};
	const pinnedSlot = settings?.pinned_items.findIndex((id) => id === item.id) ?? -1;
	if (pinnedSlot >= 0) pin.textContent = "Unpin";
	actions.appendChild(pin);
	if (!editing && item.kind !== "image") {
		const edit = document.createElement("button");
		edit.className = "detail-edit-btn";
		edit.textContent = "Edit";
		edit.onclick = () => {
			detailEditingId = item.id;
			buildDetailView(item);
		};
		actions.appendChild(edit);
	}
	top.appendChild(actions);
	return top;
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
		const clean = normalizeTagInput(tagInput.value);
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

/** Full, untruncated view of a single item (Shift+Right). */
function buildDetailView(item: Item): void {
	detailView.innerHTML = "";
	const editing = detailEditingId === item.id && item.kind !== "image";
	detailView.appendChild(buildDetailTop(item, editing));

	const body = document.createElement("div");
	body.className = "detail-body";

	if (editing) {
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
		body.appendChild(textarea);
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
		body.appendChild(actions);
		detailView.appendChild(body);
		queueMicrotask(() => textarea.focus());
		return;
	}

	if (item.kind === "image") {
		const img = document.createElement("img");
		img.className = "detail-image";
		img.src = convertFileSrc(item.text);
		body.appendChild(img);
	} else if (item.kind === "link") {
		const cached = linkPreviewCache.get(item.text);
		if (cached && cached !== "loading" && cached.title) {
			const title = document.createElement("div");
			title.className = "detail-text";
			title.title = "Click to edit";
			title.textContent = cached.title;
			title.onclick = () => {
				detailEditingId = item.id;
				buildDetailView(item);
			};
			body.appendChild(title);
		}
		const link = document.createElement("div");
		link.className = "detail-link";
		link.textContent = item.text;
		link.onclick = () => void open(item.text);
		body.appendChild(link);
	} else {
		const text = document.createElement("div");
		text.className = "detail-text";
		text.title = "Click to edit";
		text.onclick = () => {
			detailEditingId = item.id;
			buildDetailView(item);
		};
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
		body.appendChild(text);
	}

	if (item.kind !== "image") body.appendChild(buildDetailTags(item));

	const chips = document.createElement("div");
	chips.className = "detail-chips";
	const chip = (label: string): void => {
		const el = document.createElement("span");
		el.className = "detail-chip";
		el.textContent = label;
		chips.appendChild(el);
	};
	chip(CONTENT_TYPE_LABELS[item.kind]);
	if (item.source_app) chip(item.source_app);
	chip(formatAbsoluteTime(item.created_at));
	if (item.copy_count > 0) chip(`Copied ${item.copy_count}×`);
	if (item.bookmarked) chip("Bookmarked");
	body.appendChild(chips);

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
		todoBtn.textContent = isTodo ? "Note" : "Todo";
		todoBtn.onclick = async () => {
			const to = isTodo ? "note" : "todo";
			pushUndo({ type: "set_kind", id: item.id, from: item.kind, to });
			await Store.setKind(item.id, to);
			await refresh();
		};
		actions.appendChild(todoBtn);
	}

	const shareBtn = document.createElement("button");
	shareBtn.textContent = "Share";
	shareBtn.onclick = () => void shareItem(item);
	actions.appendChild(shareBtn);

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "detail-actions-danger";
	deleteBtn.textContent = "Delete";
	deleteBtn.onclick = async () => {
		pushUndo({ type: "delete", item });
		await Store.deleteItem(item.id);
		closeDetail();
		await refresh();
		showStatusToast("Deleted — ⌘Z to undo");
	};
	actions.appendChild(deleteBtn);
	body.appendChild(actions);

	const hint = document.createElement("div");
	hint.className = "detail-hint";
	hint.textContent = "Click the text or ⌘E to edit · Esc to go back";
	body.appendChild(hint);

	detailView.appendChild(body);
}

function showDetail(item: Item): void {
	detailItem = item;
	detailEditingId = null;
	buildDetailView(item);
	detailView.hidden = false;
	list.hidden = true;
	metaBar.hidden = true;
	captureRow.hidden = true;
}

/** Toggle the highlighted row in or out of the multi-selection — stay put, no auto-advance. */
function toggleMultiSelect(): void {
	if (selected < 0 || !filtered[selected]) return;
	const id = filtered[selected]!.id;
	if (multiSelected.has(id)) multiSelected.delete(id);
	else multiSelected.add(id);
	selectionAnchorId = id;
	renderList();
}

function extendSelection(delta: number): void {
	const next = extendRangeByIds(
		filtered.map((item) => item.id),
		selectionAnchorId,
		selected >= 0 ? (filtered[selected]?.id ?? null) : null,
		delta,
	);
	if (!next) return;
	selectionAnchorId = next.anchorId;
	multiSelected.clear();
	for (const id of next.selectedIds) multiSelected.add(id);
	selected = filtered.findIndex((item) => item.id === next.cursorId);
	if (selected >= listLoadedCount) listLoadedCount = selected + 1;
	renderList();
}

function closeDetail(): void {
	detailItem = null;
	detailEditingId = null;
	detailView.hidden = true;
	list.hidden = false;
	captureRow.hidden = false;
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

async function saveNew(raw: string, copy = false): Promise<void> {
	const templates = raw.startsWith("/") ? await Store.listTemplates() : [];
	const { text, kind } = resolveCapture(raw, templates);
	const item = await Store.addItem(text, kind);
	pushUndo({ type: "add", item });
	if (copy) {
		await navigator.clipboard.writeText(text);
		await Store.noteOwnClipboardWrite(text);
		await Store.logUsed(item.id);
	}
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
		input.value = "";
		selected = -1;
		renderList();
		await openSettings();
		return;
	}
	if (uiCommand?.type === "quit") {
		await Store.quitApp();
		return;
	}
	const suggestions = matchSlashSuggestions(raw, templatesCache);
	const typedName = (raw.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
	const exactMatch = suggestions.some((s) => s.name.toLowerCase() === typedName);
	if (!exactMatch && selected >= 0 && suggestions[selected]) {
		const pick = suggestions[selected]!;
		if (slashSuggestionIsImmediate(pick.name)) {
			input.value = `/${pick.name}`;
			selected = -1;
			await handleSlashEnter(`/${pick.name}`);
			return;
		}
		input.value = `/${pick.name} `;
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
			selectionAnchorId = null;
			renderList();
			return;
		}
		if (!settingsView.hidden) {
			closeSettings();
			return;
		}
		if (!detailView.hidden) {
			if (detailEditingId) {
				detailEditingId = null;
				if (detailItem) buildDetailView(detailItem);
				return;
			}
			closeDetail();
			return;
		}
		if (input.value.startsWith("/")) {
			input.value = "";
			selected = -1;
			renderList();
			return;
		}
		await Store.hidePanel();
		return;
	}

	// Settings' own form controls (selects, the shortcut recorder) need native
	// keyboard behavior; the item-list shortcuts below don't apply there.
	if (!settingsView.hidden) return;
	if (!detailView.hidden) {
		const detailMod = e.metaKey || e.ctrlKey;
		if (detailMod && e.key.toLowerCase() === "e" && detailItem && detailItem.kind !== "image") {
			e.preventDefault();
			detailEditingId = detailItem.id;
			buildDetailView(detailItem);
			return;
		}
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
		if (
			slashMode &&
			(slashMode.type === "theme" || slashMode.type === "light" || slashMode.type === "dark" || slashMode.type === "sort")
		) {
			e.preventDefault();
			await commitHighlightedSuggestion();
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
		if (raw.trim() !== "") {
			e.preventDefault();
			const rows = computeFiltered();
			const highlighted = selected >= 0 ? rows[selected] : undefined;
			const pick =
				highlighted && highlighted.kind !== "image" ? highlighted : rows.find((row) => row.kind !== "image");
			if (pick) {
				input.value = pick.text;
				selected = 0;
				renderList();
			}
			return;
		}
		e.preventDefault();
		cycleListTab(e.shiftKey ? -1 : 1);
		return;
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
	if (e.shiftKey && !modKey && raw === "" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
		e.preventDefault();
		extendSelection(e.key === "ArrowDown" ? 1 : -1);
		return;
	}
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		const delta = e.key === "ArrowDown" ? 1 : -1;
		const inSuggest = !!slashMode || inAtMode || inHashMode;
		if (inSuggest) {
			const count = currentSuggestionCount(raw);
			if (count > 0) {
				selected =
					selected < 0 ? (delta > 0 ? 0 : count - 1) : (selected + delta + count) % count;
			}
		} else {
			const next = stepLoadedSelection(selected, listLoadedCount, computeFiltered().length, delta);
			selected = next.selected;
			listLoadedCount = next.loaded;
		}
		renderList();
		return;
	}
	// ⌃Space (or Space once a range is in progress) toggles this row in
	// place — no auto-advance. Fn does not fire in WKWebView; ⌘Space is Spotlight.
	if (
		e.key === " " &&
		input.value === "" &&
		selected >= 0 &&
		filtered[selected] &&
		((e.ctrlKey && !e.metaKey) || multiSelected.size > 0)
	) {
		e.preventDefault();
		toggleMultiSelect();
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
	if (modKey && e.key.toLowerCase() === "p" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const item = filtered[selected]!;
		openCommandPalette(
			itemContextEntries(item, { inSelection: multiSelected.has(item.id), selectionCount: multiSelected.size }),
			(id) => {
				void runItemChromeAction(item, id);
			},
		);
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
	if (modKey && e.key.toLowerCase() === "c" && input.value === "") {
		if (multiSelected.size > 0) {
			e.preventDefault();
			await copyMultiSelection(false, "plain");
			return;
		}
		if (selected >= 0 && filtered[selected]) {
			e.preventDefault();
			await actOnItem(filtered[selected]!);
			return;
		}
	}
	// Empty input + Left: drop the highlight so you're back to "just the
	// input", instead of needing Escape (which would also hide the panel).
	if (e.key === "ArrowLeft" && input.value === "" && selected >= 0) {
		e.preventDefault();
		selected = -1;
		renderList();
		return;
	}
	if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && input.value === "" && selected < 0 && !e.shiftKey) {
		e.preventDefault();
		cycleListTab(e.key === "ArrowRight" ? 1 : -1);
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

	const trimmed = input.value.trim();

	// ⌘Enter force-saves and stays (does not touch the clipboard). ⇧Enter
	// force-saves, copies the new text, and stays. Empty input is a no-op
	// so a highlighted row is not acted on during rapid capture.
	if (e.shiftKey || modKey) {
		e.preventDefault();
		if (trimmed) await saveNew(trimmed, e.shiftKey && !modKey);
		return;
	}

	if (!trimmed) {
		// The common "just browsing, nothing typed" case — this used to
		// `return` unconditionally here, before ever reaching the
		// act-on-selected-item branch below, so Enter silently did nothing.
		e.preventDefault();
		if (multiSelected.size > 0) {
			await copyMultiSelectionAndClose();
		} else if (selected >= 0 && filtered[selected]) {
			const item = filtered[selected]!;
			await actOnItem(item);
			await applyHighlightSubmit(item.kind === "link");
		}
		return;
	}

	if (trimmed.startsWith("/")) {
		await handleSlashEnter(trimmed);
		return;
	}
	e.preventDefault();
	if (multiSelected.size > 0) {
		await copyMultiSelectionAndClose();
		return;
	}
	if (selected >= 0 && filtered[selected]) {
		const item = filtered[selected]!;
		await actOnItem(item);
		await applyHighlightSubmit(item.kind === "link");
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
listen("open-settings", () => {
	void openSettings();
});

// Draft capture mode (Settings -> Capture behavior): the text was grabbed
// but not saved yet — land it in the input for review instead.
listen<string>("draft-capture", (event) => {
	input.value = event.payload;
	selected = -1;
	renderList();
	input.focus();
});

// Emitted by toast.rs's `finish_arrange` once a drag-to-place session ends —
// refreshes the grid picker if Settings -> Notifications is open so it
// reflects wherever the toast actually got dropped.
listen("toast-position-changed", () => {
	void loadSettings().then(() => {
		if (!settingsView.hidden) void openSettings();
	});
});

// Emitted by dock.rs's `finish_arrange` — same reasoning as toast-position-changed above.
listen("dock-position-changed", () => {
	void loadSettings().then(() => {
		if (!settingsView.hidden) void openSettings();
	});
});

window.addEventListener("focus", () => {
	if (!captureRow.hidden) input.focus();
});

// "Click outside to close": the panel is always-on-top with no title bar, so
// losing OS focus (clicking another app, or empty desktop) is the only
// "outside" there is. Opt-out via Settings -> hide_on_blur. Skip when the
// toast preview is up — clicking that window blurs the panel but is not
// "outside", and used to hide Settings mid-preview.
window.addEventListener("blur", () => {
	if (!(settings?.hide_on_blur ?? true)) return;
	window.setTimeout(() => {
		void (async () => {
			const windows = await getAllWebviewWindows();
			const toast = windows.find((w) => w.label === "toast");
			if (toast && (await toast.isVisible()) && !settingsView.hidden) return;
			if (document.hasFocus()) return;
			void Store.hidePanel();
		})();
	}, 80);
});

async function persistPanelFrame(): Promise<void> {
	const win = getCurrentWindow();
	const size = await win.innerSize();
	const pos = await win.outerPosition();
	const scale = await win.scaleFactor();
	await Store.savePanelFrame(
		Math.round(size.width / scale),
		Math.round(size.height / scale),
		Math.round(pos.x / scale),
		Math.round(pos.y / scale),
	);
}

let persistPanelFrameTimer: ReturnType<typeof setTimeout> | undefined;
let applyingProgrammaticFrame = false;
function schedulePersistPanelFrame(): void {
	if (applyingProgrammaticFrame) return;
	clearTimeout(persistPanelFrameTimer);
	persistPanelFrameTimer = setTimeout(() => void persistPanelFrame(), 300);
}

async function applyPanelSize(width: number, height: number): Promise<void> {
	const win = getCurrentWindow();
	const pos = await win.outerPosition();
	const scale = await win.scaleFactor();
	applyingProgrammaticFrame = true;
	await win.setSize(new LogicalSize(width, height));
	await Store.savePanelFrame(width, height, Math.round(pos.x / scale), Math.round(pos.y / scale));
	window.setTimeout(() => {
		applyingProgrammaticFrame = false;
	}, 400);
}

const panelWindow = getCurrentWindow();
void panelWindow.onResized(() => schedulePersistPanelFrame());
void panelWindow.onMoved(() => schedulePersistPanelFrame());

panelDrag.addEventListener("mousedown", (e) => {
	if (e.button !== 0) return;
	void panelWindow.startDragging();
});
metaBar.addEventListener("mousedown", (e) => {
	if (e.button !== 0) return;
	if (e.target !== metaBar) return;
	void panelWindow.startDragging();
});

const ACTION_LABELS: Record<Action, string> = {
	capture: "Capture selection",
	toggle_panel: "Toggle panel",
	none: "Do nothing",
};

/** Mirrors the in-panel banner (see `checkAccessibilityPermission`) for anyone who wants to check without hunting — a no-op on non-mac, where `trusted` is always true. */
function buildAccessibilityStatusRow(trusted: boolean): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	const label = document.createElement("label");
	label.textContent = "Accessibility access";
	row.appendChild(label);
	const status = document.createElement("span");
	status.className = "settings-readout";
	status.textContent = trusted ? "Granted" : "Not granted";
	row.appendChild(status);
	if (!trusted) {
		const fixBtn = document.createElement("button");
		fixBtn.textContent = "Open Settings";
		fixBtn.onclick = () => void Store.openAccessibilitySettings();
		row.appendChild(fixBtn);
	}
	return row;
}

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
	const reset = document.createElement("button");
	reset.textContent = "Reset theme";
	reset.title = "Restore this theme's default colors and clear the opacity override";
	reset.onclick = async () => {
		const latest = await loadSettings();
		const next = { ...latest, panel_opacity: 0 };
		settings = next;
		clearCustomPalette(document.documentElement);
		applyTheme(next.theme);
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(reset);
	return row;
}

function buildSizeSliderRow(
	label: string,
	search: string,
	value: number,
	fallback: number,
	min: number,
	max: number,
	onCommit: (next: number) => Promise<void>,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	row.dataset.search = search;
	const name = document.createElement("label");
	name.textContent = label;
	row.appendChild(name);
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = "10";
	const current = value > 0 ? value : fallback;
	slider.value = String(current);
	const readout = document.createElement("span");
	readout.className = "settings-readout";
	readout.textContent = `${current}px`;
	slider.oninput = () => {
		readout.textContent = `${slider.value}px`;
	};
	slider.onchange = () => void onCommit(Number(slider.value));
	row.appendChild(slider);
	row.appendChild(readout);
	return row;
}

function buildPanelSizeRows(current: Settings): HTMLElement[] {
	const width = current.panel_width > 0 ? current.panel_width : 640;
	const height = current.panel_height > 0 ? current.panel_height : 420;
	const apply = async (patch: { width?: number; height?: number }): Promise<void> => {
		const latest = await loadSettings();
		const nextWidth = patch.width ?? (latest.panel_width > 0 ? latest.panel_width : 640);
		const nextHeight = patch.height ?? (latest.panel_height > 0 ? latest.panel_height : 420);
		settings = { ...latest, panel_width: nextWidth, panel_height: nextHeight };
		await applyPanelSize(nextWidth, nextHeight);
	};
	const resetRow = document.createElement("div");
	resetRow.className = "settings-row";
	resetRow.dataset.search = "size width height panel window resize reset default";
	const reset = document.createElement("button");
	reset.textContent = "Reset window size";
	reset.onclick = async () => {
		const latest = await loadSettings();
		settings = { ...latest, panel_width: 640, panel_height: 420 };
		await applyPanelSize(640, 420);
		await openSettings();
	};
	resetRow.appendChild(reset);
	return [
		buildSizeSliderRow("Window width", "size width panel window resize", width, 640, 360, 1200, (w) => apply({ width: w })),
		buildSizeSliderRow("Window height", "size height panel window resize", height, 420, 280, 900, (h) => apply({ height: h })),
		resetRow,
	];
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
	name.textContent = "Override panel opacity";
	row.appendChild(name);

	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = "15";
	slider.max = "100";
	slider.value = String(current.panel_opacity > 0 ? current.panel_opacity : 50);
	slider.disabled = current.panel_opacity === 0;
	const readout = document.createElement("span");
	readout.className = "settings-readout";
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
		applyInputSpellcheck(next.input_spellcheck);
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(checkbox);
	return row;
}

const NOTIFICATION_STYLE_LABELS: Record<NotificationStyle, string> = {
	none: "None",
	native: "Native — OS notification banner",
	custom: "Ours — a small animated check-and-sparkle toast",
};

const NOTIFY_CONTENT_LABELS: Record<NotifyContent, string> = {
	icon_only: "Icon only",
	icon_title: "Icon + \"Note saved\"",
	icon_title_excerpt: "Icon + \"Note saved\" + excerpt",
	icon_excerpt: "Icon + excerpt",
};

function buildNotificationStyleRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "Notify when something is saved";
	row.appendChild(name);

	const select = document.createElement("select");
	for (const style of Object.keys(NOTIFICATION_STYLE_LABELS) as NotificationStyle[]) {
		if (style === "native" && current.notify_content === "icon_only") continue;
		const option = document.createElement("option");
		option.value = style;
		option.textContent = NOTIFICATION_STYLE_LABELS[style];
		option.selected = current.notification_style === style;
		select.appendChild(option);
	}
	select.onchange = async () => {
		const latest = await loadSettings();
		const next = { ...latest, notification_style: select.value as NotificationStyle };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	row.appendChild(select);
	return row;
}

/** Applies to both "native" and "custom" — what's actually shown, regardless of which style renders it. */
function buildNotifyContentRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	const disabled = current.notification_style === "none";

	const name = document.createElement("label");
	name.textContent = "Show";
	row.appendChild(name);

	const select = document.createElement("select");
	select.disabled = disabled;
	for (const content of Object.keys(NOTIFY_CONTENT_LABELS) as NotifyContent[]) {
		if (content === "icon_only" && current.notification_style === "native") continue;
		const option = document.createElement("option");
		option.value = content;
		option.textContent = NOTIFY_CONTENT_LABELS[content];
		option.selected = current.notify_content === content;
		select.appendChild(option);
	}
	select.onchange = async () => {
		const latest = await loadSettings();
		const notify_content = select.value as NotifyContent;
		const notification_style =
			notify_content === "icon_only" && latest.notification_style === "native" ? "custom" : latest.notification_style;
		const next = { ...latest, notify_content, notification_style };
		settings = next;
		await Store.setSettings(next);
		if (next.notification_style === "custom") {
			void Store.previewToastPosition(next.toast_position, next.toast_custom_x, next.toast_custom_y);
		}
		if (notification_style !== latest.notification_style) await openSettings();
	};
	row.appendChild(select);
	return row;
}

/** Duration + text size — "custom" style only, native banners are OS-controlled on both fronts. */
function buildToastAppearanceRows(current: Settings): HTMLElement[] {
	const disabled = current.notification_style !== "custom";

	const durationRow = document.createElement("div");
	durationRow.className = "settings-row";
	const durationLabel = document.createElement("label");
	durationLabel.textContent = "Duration";
	durationRow.appendChild(durationLabel);
	const durationSlider = document.createElement("input");
	durationSlider.type = "range";
	durationSlider.min = "500";
	durationSlider.max = "5000";
	durationSlider.step = "100";
	durationSlider.value = String(current.toast_duration_ms);
	durationSlider.disabled = disabled;
	const durationReadout = document.createElement("span");
	durationReadout.className = "settings-readout";
	durationReadout.textContent = `${(Number(durationSlider.value) / 1000).toFixed(1)}s`;
	durationSlider.oninput = () => {
		durationReadout.textContent = `${(Number(durationSlider.value) / 1000).toFixed(1)}s`;
	};
	durationSlider.onchange = async () => {
		if (!settings) return;
		settings = { ...settings, toast_duration_ms: Number(durationSlider.value) };
		await Store.setSettings(settings);
	};
	durationRow.appendChild(durationSlider);
	durationRow.appendChild(durationReadout);

	const scaleRow = document.createElement("div");
	scaleRow.className = "settings-row";
	const scaleLabel = document.createElement("label");
	scaleLabel.textContent = "Text size";
	scaleRow.appendChild(scaleLabel);
	const scaleSlider = document.createElement("input");
	scaleSlider.type = "range";
	scaleSlider.min = "50";
	scaleSlider.max = "200";
	scaleSlider.step = "10";
	scaleSlider.value = String(current.toast_font_scale);
	scaleSlider.disabled = disabled;
	const scaleReadout = document.createElement("span");
	scaleReadout.className = "settings-readout";
	scaleReadout.textContent = `${scaleSlider.value}%`;
	scaleSlider.oninput = () => {
		scaleReadout.textContent = `${scaleSlider.value}%`;
	};
	scaleSlider.onchange = async () => {
		if (!settings) return;
		settings = { ...settings, toast_font_scale: Number(scaleSlider.value) };
		await Store.setSettings(settings);
		void Store.previewToastPosition(settings.toast_position, settings.toast_custom_x, settings.toast_custom_y);
	};
	scaleRow.appendChild(scaleSlider);
	scaleRow.appendChild(scaleReadout);

	return [durationRow, scaleRow];
}

/** Reading order (left-to-right, top-to-bottom) matches the 3x3 grid's DOM order below. */
const TOAST_POSITION_GRID: ToastPosition[] = [
	"top_left",
	"top_center",
	"top_right",
	"middle_left",
	"center",
	"middle_right",
	"bottom_left",
	"bottom_center",
	"bottom_right",
];

/** Only meaningful for `notification_style === "custom"` — where the small toast window (see toast.ts) sits on screen. */
function buildToastPositionRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	const disabled = current.notification_style !== "custom";

	row.dataset.search = "toast notification edge corner screen position place";
	const name = document.createElement("label");
	name.textContent = "Position";
	row.appendChild(name);

	const grid = document.createElement("div");
	grid.className = "toast-position-grid";
	for (const position of TOAST_POSITION_GRID) {
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "toast-position-cell";
		cell.disabled = disabled;
		cell.classList.toggle("toast-position-cell-active", current.toast_position === position);
		cell.title = position.replace(/_/g, " ");
		cell.setAttribute("aria-label", cell.title);
		cell.onclick = async () => {
			const latest = await loadSettings();
			const next = { ...latest, toast_position: position };
			settings = next;
			await Store.setSettings(next);
			for (const other of grid.querySelectorAll(".toast-position-cell-active")) other.classList.remove("toast-position-cell-active");
			cell.classList.add("toast-position-cell-active");
			void Store.previewToastPosition(position, next.toast_custom_x, next.toast_custom_y);
		};
		grid.appendChild(cell);
	}
	row.appendChild(grid);

	const dragBtn = document.createElement("button");
	dragBtn.textContent = current.toast_position === "custom" ? "Free — drag preview to re-place" : "Free — drag preview anywhere";
	dragBtn.disabled = disabled;
	dragBtn.onclick = () => void Store.startToastArrange();
	row.appendChild(dragBtn);

	return row;
}

/** Perimeter anchors — never the screen center. */
const DOCK_ANCHORS: Array<{ position: ToastPosition; col: number; row: number }> = [
	{ position: "top_left", col: 1, row: 1 },
	{ position: "top_mid_left", col: 2, row: 1 },
	{ position: "top_center", col: 4, row: 1 },
	{ position: "top_mid_right", col: 6, row: 1 },
	{ position: "top_right", col: 7, row: 1 },
	{ position: "left_top", col: 1, row: 2 },
	{ position: "right_top", col: 7, row: 2 },
	{ position: "left_upper", col: 1, row: 3 },
	{ position: "right_upper", col: 7, row: 3 },
	{ position: "middle_left", col: 1, row: 4 },
	{ position: "middle_right", col: 7, row: 4 },
	{ position: "left_lower", col: 1, row: 5 },
	{ position: "right_lower", col: 7, row: 5 },
	{ position: "left_bottom", col: 1, row: 6 },
	{ position: "right_bottom", col: 7, row: 6 },
	{ position: "bottom_left", col: 1, row: 7 },
	{ position: "bottom_mid_left", col: 2, row: 7 },
	{ position: "bottom_center", col: 4, row: 7 },
	{ position: "bottom_mid_right", col: 6, row: 7 },
	{ position: "bottom_right", col: 7, row: 7 },
];

/** Off by default — a small always-visible pill of recent captures, see dock.rs/dock.ts. */
function buildDockRows(current: Settings): HTMLElement[] {
	const disabled = !current.dock_enabled;

	const positionRow = document.createElement("div");
	positionRow.className = "settings-row";
	positionRow.dataset.search = "dock notch pill edge corner screen position place recent";
	const positionLabel = document.createElement("label");
	positionLabel.textContent = "Position";
	positionRow.appendChild(positionLabel);
	const grid = document.createElement("div");
	grid.className = "dock-anchor-grid";
	for (const anchor of DOCK_ANCHORS) {
		const cell = document.createElement("button");
		cell.type = "button";
		cell.className = "toast-position-cell";
		cell.disabled = disabled;
		cell.style.gridColumn = String(anchor.col);
		cell.style.gridRow = String(anchor.row);
		cell.classList.toggle("toast-position-cell-active", current.dock_position === anchor.position);
		cell.title = anchor.position.replace(/_/g, " ");
		cell.setAttribute("aria-label", cell.title);
		cell.onclick = async () => {
			const latest = await loadSettings();
			const next = { ...latest, dock_position: anchor.position };
			settings = next;
			await Store.setSettings(next);
			for (const other of grid.querySelectorAll(".toast-position-cell-active")) other.classList.remove("toast-position-cell-active");
			cell.classList.add("toast-position-cell-active");
		};
		grid.appendChild(cell);
	}
	positionRow.appendChild(grid);
	const dragBtn = document.createElement("button");
	dragBtn.textContent = current.dock_position === "custom" ? "Custom (drag to re-place)" : "Drag to place…";
	dragBtn.disabled = disabled;
	dragBtn.onclick = () => void Store.startDockArrange();
	positionRow.appendChild(dragBtn);

	const countRow = document.createElement("div");
	countRow.className = "settings-row";
	countRow.dataset.search = "dock notch recent items count";
	const countLabel = document.createElement("label");
	countLabel.textContent = "Visible rows (scroll loads the rest)";
	countRow.appendChild(countLabel);
	const countSlider = document.createElement("input");
	countSlider.type = "range";
	countSlider.min = "1";
	countSlider.max = "16";
	countSlider.value = String(current.dock_item_count);
	countSlider.disabled = disabled;
	const countReadout = document.createElement("span");
	countReadout.className = "settings-readout";
	countReadout.textContent = countSlider.value;
	countSlider.oninput = () => (countReadout.textContent = countSlider.value);
	countSlider.onchange = async () => {
		const latest = await loadSettings();
		const count = Number(countSlider.value);
		const row = latest.dock_row_height > 0 ? latest.dock_row_height : 36;
		const height = Math.round(94 + count * row + Math.max(0, count - 1) * 6);
		const width = latest.dock_expanded_width > 0 ? latest.dock_expanded_width : 320;
		await Store.setSettings({ ...latest, dock_item_count: count, dock_row_height: row });
		await Store.saveDockFrame(width, height);
		settings = { ...latest, dock_item_count: count, dock_row_height: row, dock_expanded_width: width, dock_expanded_height: height };
	};
	countRow.appendChild(countSlider);
	countRow.appendChild(countReadout);

	const applyExpanded = async (patch: { width?: number; height?: number }): Promise<void> => {
		const latest = await loadSettings();
		const width = patch.width ?? (latest.dock_expanded_width > 0 ? latest.dock_expanded_width : 320);
		const height = patch.height ?? (latest.dock_expanded_height > 0 ? latest.dock_expanded_height : 508);
		await Store.saveDockFrame(width, height);
		settings = { ...latest, dock_expanded_width: width, dock_expanded_height: height };
	};
	const expandedWidth = current.dock_expanded_width > 0 ? current.dock_expanded_width : 320;
	const expandedHeight = current.dock_expanded_height > 0 ? current.dock_expanded_height : 508;
	const rowHeight = current.dock_row_height > 0 ? current.dock_row_height : 36;
	const rowRow = document.createElement("div");
	rowRow.className = "settings-row";
	rowRow.dataset.search = "dock notch row height size compact density";
	const rowLabel = document.createElement("label");
	rowLabel.textContent = "Row height";
	rowRow.appendChild(rowLabel);
	const rowSlider = document.createElement("input");
	rowSlider.type = "range";
	rowSlider.min = "28";
	rowSlider.max = "56";
	rowSlider.value = String(rowHeight);
	rowSlider.disabled = disabled;
	const rowReadout = document.createElement("span");
	rowReadout.className = "settings-readout";
	rowReadout.textContent = `${rowHeight}px`;
	rowSlider.oninput = () => (rowReadout.textContent = `${rowSlider.value}px`);
	rowSlider.onchange = async () => {
		const latest = await loadSettings();
		const nextHeight = Number(rowSlider.value);
		const width = latest.dock_expanded_width > 0 ? latest.dock_expanded_width : 320;
		const height = latest.dock_expanded_height > 0 ? latest.dock_expanded_height : 508;
		await Store.setSettings({ ...latest, dock_row_height: nextHeight });
		await Store.saveDockFrame(width, height);
		settings = { ...latest, dock_row_height: nextHeight };
	};
	rowRow.appendChild(rowSlider);
	rowRow.appendChild(rowReadout);
	const autoRow = document.createElement("div");
	autoRow.className = "settings-row";
	autoRow.dataset.search = "dock notch expanded size auto rail reset";
	const autoBtn = document.createElement("button");
	autoBtn.textContent = "Auto rail size";
	autoBtn.disabled = disabled;
	autoBtn.onclick = async () => {
		const latest = await loadSettings();
		const next = { ...latest, dock_expanded_width: 0, dock_expanded_height: 0 };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	autoRow.appendChild(autoBtn);

	return [
		buildCheckboxRow("Show recent-items dock", current.dock_enabled, false, (checked) => ({ dock_enabled: checked })),
		positionRow,
		countRow,
		rowRow,
		buildSizeSliderRow("Expanded width", "dock notch expanded size width", expandedWidth, 320, 160, 560, (w) =>
			applyExpanded({ width: w }),
		),
		buildSizeSliderRow("Expanded height", "dock notch expanded size height", expandedHeight, 508, 140, 720, (h) =>
			applyExpanded({ height: h }),
		),
		autoRow,
	];
}

/** Sound name + volume are independent of `notification_style`/`notify_sound` so the fields survive being toggled off and back on. */
function buildSoundRows(current: Settings): HTMLElement[] {
	const gated = current.notification_style === "none" || !current.notify_sound;

	const volumeSlider = document.createElement("input");
	volumeSlider.type = "range";
	volumeSlider.min = "0";
	volumeSlider.max = "100";
	volumeSlider.value = String(current.notify_sound_volume);
	volumeSlider.disabled = gated;

	const soundSelect = document.createElement("select");
	soundSelect.disabled = gated;
	for (const soundName of SYSTEM_SOUNDS) {
		const option = document.createElement("option");
		option.value = soundName;
		option.textContent = soundName;
		option.selected = current.notify_sound_name === soundName;
		soundSelect.appendChild(option);
	}

	const soundRow = document.createElement("div");
	soundRow.className = "settings-row";
	const soundLabel = document.createElement("label");
	soundLabel.textContent = "Sound";
	soundRow.appendChild(soundLabel);
	soundSelect.onchange = async () => {
		if (!settings) return;
		settings = { ...settings, notify_sound_name: soundSelect.value };
		await Store.setSettings(settings);
		void Store.previewSound(soundSelect.value, Number(volumeSlider.value));
	};
	soundRow.appendChild(soundSelect);
	const previewBtn = document.createElement("button");
	previewBtn.textContent = "Preview";
	previewBtn.disabled = gated;
	previewBtn.onclick = () => void Store.previewSound(soundSelect.value, Number(volumeSlider.value));
	soundRow.appendChild(previewBtn);

	const volumeRow = document.createElement("div");
	volumeRow.className = "settings-row";
	const volumeLabel = document.createElement("label");
	volumeLabel.textContent = "Volume";
	volumeRow.appendChild(volumeLabel);
	const readout = document.createElement("span");
	readout.className = "settings-readout";
	readout.textContent = `${volumeSlider.value}%`;
	volumeSlider.oninput = () => {
		readout.textContent = `${volumeSlider.value}%`;
	};
	volumeSlider.onchange = async () => {
		if (!settings) return;
		settings = { ...settings, notify_sound_volume: Number(volumeSlider.value) };
		await Store.setSettings(settings);
		void Store.previewSound(soundSelect.value, Number(volumeSlider.value));
	};
	volumeRow.appendChild(volumeSlider);
	volumeRow.appendChild(readout);

	return [
		buildCheckboxRow(
			"Play a sound",
			current.notify_sound,
			current.notification_style === "none",
			(checked) => ({ notify_sound: checked }),
		),
		soundRow,
		volumeRow,
	];
}

function buildNotificationRows(current: Settings): HTMLElement[] {
	const testRow = document.createElement("div");
	testRow.className = "settings-row";
	testRow.dataset.search = "toast notify alert test preview sample";
	const testLabel = document.createElement("label");
	testLabel.textContent = "Try it";
	testRow.appendChild(testLabel);
	const testBtn = document.createElement("button");
	testBtn.textContent = "Test notification";
	testBtn.onclick = () => void Store.previewNotification();
	testRow.appendChild(testBtn);

	return [
		buildNotificationStyleRow(current),
		buildNotifyContentRow(current),
		buildToastPositionRow(current),
		...buildToastAppearanceRows(current),
		...buildSoundRows(current),
		testRow,
	];
}

const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
	silent: "Silent — save without showing the panel",
	open: "Open — save and show the panel",
	draft: "Draft — show the panel with the text prefilled, not yet saved",
};

const HIGHLIGHT_SUBMIT_LABELS: Record<HighlightSubmit, string> = {
	copy: "Copy only — keep the panel open",
	copy_hide: "Copy and hide",
	copy_hide_write: "Copy, hide, and paste where you were",
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

function buildHighlightSubmitRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = "On Enter (highlighted item)";
	row.appendChild(name);

	const select = document.createElement("select");
	for (const mode of Object.keys(HIGHLIGHT_SUBMIT_LABELS) as HighlightSubmit[]) {
		const option = document.createElement("option");
		option.value = mode;
		option.textContent = HIGHLIGHT_SUBMIT_LABELS[mode];
		option.selected = current.highlight_submit === mode;
		select.appendChild(option);
	}
	select.onchange = async () => {
		const next = { ...current, highlight_submit: select.value as HighlightSubmit };
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
			"Autocorrect / spellcheck on the capture input",
			current.input_spellcheck,
			false,
			(checked) => ({ input_spellcheck: checked }),
		),
		buildCheckboxRow(
			"Auto-capture everything copied (clipboard watch)",
			current.clipboard_watch,
			false,
			(checked) => ({ clipboard_watch: checked }),
		),
	];
}

function buildPinnedItemsSection(current: Settings): HTMLElement {
	const wrapper = document.createElement("div");
	let assigned = 0;
	for (let slot = 0; slot < 9; slot++) {
		const id = current.pinned_items[slot];
		if (!id) continue;
		assigned++;
		const item = items.find((i) => i.id === id);
		const row = document.createElement("div");
		row.className = "settings-row";
		const label = document.createElement("label");
		label.textContent = `⌘${slot + 1}`;
		row.appendChild(label);
		const value = document.createElement("span");
		value.className = "pinned-item-value";
		value.textContent = item ? item.text : "(item no longer exists)";
		row.appendChild(value);
		const clearBtn = document.createElement("button");
		clearBtn.textContent = "Clear";
		clearBtn.onclick = async () => {
			const next = { ...current, pinned_items: current.pinned_items.map((v, i) => (i === slot ? "" : v)) };
			settings = next;
			await Store.setSettings(next);
			await openSettings();
		};
		row.appendChild(clearBtn);
		wrapper.appendChild(row);
	}
	const hint = document.createElement("div");
	hint.className = "settings-row";
	hint.textContent =
		assigned === 0
			? "None yet — highlight a row, then ⌘⇧1–9 to pin it."
			: "Highlight a row and press ⌘⇧1–9 to pin another.";
	wrapper.appendChild(hint);
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
		buildCheckboxRow("Launch at login", current.launch_at_login, false, (checked) => ({ launch_at_login: checked })),
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

/** Whole-settings export/import to reproduce your setup on another machine — same clipboard-JSON pattern as custom themes' import/export, just for every setting instead of just themes. Includes S3 credentials if configured, since this is meant to fully reproduce your own setup; be mindful of where the copied text ends up (a public dotfiles repo, etc). */
function buildConfigBackupRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const exportBtn = document.createElement("button");
	exportBtn.textContent = "Export to clipboard";
	exportBtn.onclick = async () => {
		const custom_themes = await Store.listCustomThemes();
		await navigator.clipboard.writeText(JSON.stringify({ settings: current, custom_themes }, null, 2));
		exportBtn.textContent = "Copied!";
		setTimeout(() => (exportBtn.textContent = "Export to clipboard"), 1500);
	};
	row.appendChild(exportBtn);

	const importBtn = document.createElement("button");
	importBtn.textContent = "Import from clipboard";
	importBtn.onclick = async () => {
		try {
			const raw = await navigator.clipboard.readText();
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null) {
				throw new Error("not a shiftshift settings export");
			}
			const record = parsed as Record<string, unknown>;
			const settingsPayload =
				typeof record.settings === "object" && record.settings !== null && "bindings" in (record.settings as object)
					? (record.settings as Partial<Settings>)
					: "bindings" in record
						? (record as Partial<Settings>)
						: null;
			if (!settingsPayload) throw new Error("not a shiftshift settings export");
			const next = { ...current, ...settingsPayload };
			settings = next;
			await Store.setSettings(next);
			if (Array.isArray(record.custom_themes)) {
				const imported: CustomTheme[] = [];
				for (const entry of record.custom_themes) {
					if (typeof entry !== "object" || entry === null) continue;
					const theme = entry as Record<string, unknown>;
					if (typeof theme.id !== "string" || !theme.id) continue;
					if (!isImportableTheme({ name: theme.name, mode: theme.mode, colors: theme.colors })) continue;
					imported.push({
						id: theme.id,
						name: theme.name as string,
						mode: theme.mode as "light" | "dark",
						colors: normalizeThemeColors(theme.colors as ThemeColors),
					});
				}
				if (imported.length > 0) {
					await Store.replaceCustomThemes(imported);
					customThemesCache = imported;
				}
			}
			importBtn.textContent = "Imported!";
			setTimeout(() => (importBtn.textContent = "Import from clipboard"), 1500);
			await openSettings();
		} catch {
			importBtn.textContent = "Invalid clipboard content";
			setTimeout(() => (importBtn.textContent = "Import from clipboard"), 1500);
		}
	};
	row.appendChild(importBtn);

	const resetAll = document.createElement("button");
	resetAll.textContent = "Reset all settings";
	resetAll.title = "Factory defaults. Custom themes and the S3 key stay.";
	resetAll.onclick = async () => {
		if (!window.confirm("Reset every setting to factory defaults? Custom themes stay.")) return;
		settings = await Store.resetSettings();
		clearCustomPalette(document.documentElement);
		applyTheme(settings.theme);
		applyingProgrammaticFrame = true;
		await getCurrentWindow().setSize(new LogicalSize(640, 420));
		window.setTimeout(() => {
			applyingProgrammaticFrame = false;
		}, 400);
		await openSettings();
		showStatusToast("Settings reset");
	};
	row.appendChild(resetAll);

	return row;
}

/** "Check for updates" against the GitHub Releases `latest.json` — see tauri.conf.json's `plugins.updater`. Manual only (no auto-check on startup) so a fresh install never phones home without the user asking. */
async function buildUpdatesRow(): Promise<HTMLElement> {
	const row = document.createElement("div");
	row.className = "settings-row";

	const status = document.createElement("span");
	status.textContent = `Version ${await getVersion()}`;
	row.appendChild(status);

	const checkBtn = document.createElement("button");
	checkBtn.textContent = "Check for updates";
	checkBtn.onclick = async () => {
		checkBtn.disabled = true;
		checkBtn.textContent = "Checking…";
		try {
			const update = await checkForUpdate();
			if (!update) {
				checkBtn.textContent = "Up to date";
				setTimeout(() => {
					checkBtn.textContent = "Check for updates";
					checkBtn.disabled = false;
				}, 1500);
				return;
			}
			checkBtn.textContent = `Install v${update.version} & restart`;
			checkBtn.disabled = false;
			checkBtn.onclick = async () => {
				checkBtn.disabled = true;
				checkBtn.textContent = "Installing…";
				await update.downloadAndInstall();
				await relaunch();
			};
		} catch (err) {
			checkBtn.textContent = "Check failed";
			console.error(err);
			setTimeout(() => {
				checkBtn.textContent = "Check for updates";
				checkBtn.disabled = false;
			}, 1500);
		}
	};
	row.appendChild(checkBtn);

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

/** Write-only field, stored in the OS keychain rather than settings.json — see settings.rs's `S3Settings` doc comment. The input always starts blank; leaving it blank on save keeps whatever's already stored, typing a value replaces it, "Clear" removes it. */
function buildS3SecretRow(current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";
	const labelEl = document.createElement("label");
	labelEl.textContent = "Secret access key";
	row.appendChild(labelEl);

	const fieldInput = document.createElement("input");
	fieldInput.type = "password";
	fieldInput.placeholder = "…";
	void Store.s3SecretConfigured().then((configured) => {
		fieldInput.placeholder = configured ? "(unchanged — leave blank to keep)" : "(not set)";
	});
	fieldInput.onchange = async () => {
		if (!fieldInput.value) return;
		const next = { ...current, s3: { ...current.s3, secret_access_key: fieldInput.value } };
		settings = next;
		await Store.setSettings(next);
		fieldInput.value = "";
		fieldInput.placeholder = "(unchanged — leave blank to keep)";
	};
	row.appendChild(fieldInput);

	const clearBtn = document.createElement("button");
	clearBtn.textContent = "Clear";
	clearBtn.onclick = async () => {
		await Store.clearS3Secret();
		fieldInput.value = "";
		fieldInput.placeholder = "(not set)";
	};
	row.appendChild(clearBtn);

	return row;
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

	const rows: HTMLElement[] = [backendRow];
	if (current.backend === "s3") {
		const details = document.createElement("details");
		details.className = "settings-collapsible";
		details.open = true;
		const summary = document.createElement("summary");
		summary.textContent = "S3 credentials";
		details.appendChild(summary);
		const inner = document.createElement("div");
		const fields: Array<[keyof S3Settings, string]> = [
			["endpoint", "Endpoint (e.g. https://s3.us-east-1.amazonaws.com)"],
			["bucket", "Bucket"],
			["region", "Region"],
			["access_key_id", "Access key ID"],
			["prefix", "Key prefix (optional)"],
		];
		for (const [field, label] of fields) {
			const row = document.createElement("div");
			row.className = "settings-row";
			const labelEl = document.createElement("label");
			labelEl.textContent = label;
			row.appendChild(labelEl);
			const fieldInput = document.createElement("input");
			fieldInput.type = "text";
			fieldInput.value = current.s3[field];
			fieldInput.onchange = async () => {
				const next = { ...current, s3: { ...current.s3, [field]: fieldInput.value } };
				settings = next;
				await Store.setSettings(next);
			};
			row.appendChild(fieldInput);
			inner.appendChild(row);
		}
		inner.appendChild(buildS3SecretRow(current));
		details.appendChild(inner);
		rows.push(details);
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

function cssColorToHex(value: string): string {
	const hex = value.trim();
	const short = /^#([0-9a-f]{3})$/i.exec(hex);
	if (short) {
		const [r, g, b] = short[1]!;
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
	}
	if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
	const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex);
	if (!rgb) return "#888888";
	const to = (n: string): string => Number(n).toString(16).padStart(2, "0");
	return `#${to(rgb[1]!)}${to(rgb[2]!)}${to(rgb[3]!)}`;
}

function parseAlphaPercent(value: string): number {
	const n = Number.parseInt(value.replace("%", ""), 10);
	return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

function parsePx(value: string, fallback: number): number {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
}

function computedThemeColors(): ThemeColors {
	const style = getComputedStyle(document.documentElement);
	const get = (name: string): string => style.getPropertyValue(name).trim();
	return normalizeThemeColors({
		bg: cssColorToHex(get("--bg")),
		fg: cssColorToHex(get("--fg")),
		muted: cssColorToHex(get("--muted")),
		row_bg: cssColorToHex(get("--row-bg")),
		accent: cssColorToHex(get("--accent")),
		accent_fg: cssColorToHex(get("--accent-fg")),
		border: cssColorToHex(get("--border")),
		bg_alpha: parseAlphaPercent(get("--bg-alpha") || "100"),
		row_alpha: parseAlphaPercent(get("--row-alpha") || "100"),
		input_bg: cssColorToHex(get("--input-bg") || get("--row-bg")),
		input_fg: cssColorToHex(get("--input-fg") || get("--fg")),
		input_border: cssColorToHex(get("--input-border") || get("--border")),
		button_bg: cssColorToHex(get("--button-bg") || get("--row-bg")),
		button_fg: cssColorToHex(get("--button-fg") || get("--fg")),
		selected_bg: cssColorToHex(get("--selected-bg") || get("--accent")),
		hover_bg: cssColorToHex(get("--hover-bg") || get("--row-bg")),
		danger: cssColorToHex(get("--danger") || "#e05d5d"),
		meta: cssColorToHex(get("--meta") || get("--muted")),
		radius: parsePx(get("--radius") || "16", 16),
		radius_sm: parsePx(get("--radius-sm") || "10", 10),
		font_family: get("--font-family"),
		font_size: parsePx(get("--font-size") || "14", 14),
		font_weight: parsePx(get("--font-weight-ui") || "500", 500),
		border_width: parsePx(get("--panel-border-width") || "1", 1),
		backdrop_blur: parsePx(get("--backdrop-blur") || "0", 0),
		press_offset: parsePx(get("--press-offset") || "0", 0),
		gap: parsePx(get("--gap") || "10", 10),
		pad: parsePx(get("--pad") || "12", 12),
		window_radius: parsePx(get("--window-radius") || get("--radius") || "16", 16),
	});
}

const COLOR_GROUPS: Array<{ title: string; fields: Array<[string, keyof ThemeColors]> }> = [
	{
		title: "Surfaces",
		fields: [
			["Panel", "bg"],
			["Rows", "row_bg"],
			["Input", "input_bg"],
			["Buttons", "button_bg"],
			["Selected row", "selected_bg"],
			["Hover row", "hover_bg"],
		],
	},
	{
		title: "Text",
		fields: [
			["Text", "fg"],
			["Muted", "muted"],
			["Input text", "input_fg"],
			["Button text", "button_fg"],
			["Timestamps", "meta"],
			["Accent text", "accent_fg"],
		],
	},
	{
		title: "Lines & accents",
		fields: [
			["Border", "border"],
			["Input border", "input_border"],
			["Accent", "accent"],
			["Danger", "danger"],
		],
	},
];

function previewDraftTheme(colors: ThemeColors, mode: "light" | "dark"): void {
	applyCustomPalette(document.documentElement, colors, mode);
	if (settings && settings.panel_opacity > 0) {
		document.documentElement.style.setProperty("--bg-alpha", `${settings.panel_opacity}%`);
	}
}

function buildCustomThemeForm(editing: CustomTheme | null, onSaved: () => Promise<void>): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "custom-theme-form";

	const heading = document.createElement("div");
	heading.className = "custom-theme-form-title";
	heading.textContent = editing ? `Editing "${editing.name}" — live` : "New theme — starts from what you see now, live as you edit";
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

	const colors: ThemeColors = normalizeThemeColors(editing ? { ...editing.colors } : computedThemeColors());

	const preview = document.createElement("div");
	preview.className = "theme-preview-strip";
	preview.innerHTML = `<strong>Preview row</strong><em>selected</em><span>now</span>`;
	wrapper.appendChild(preview);

	const paint = (): void => {
		previewDraftTheme(colors, modeSelect.value as "light" | "dark");
	};
	modeSelect.onchange = () => paint();
	if (editing) paint();

	const colorFields = document.createElement("div");
	colorFields.className = "color-fields";
	for (const group of COLOR_GROUPS) {
		const groupEl = document.createElement("div");
		groupEl.className = "color-field-group";
		const title = document.createElement("div");
		title.className = "color-field-group-title";
		title.textContent = group.title;
		groupEl.appendChild(title);
		for (const [label, key] of group.fields) {
			const field = document.createElement("div");
			field.className = "color-field";
			const fieldLabel = document.createElement("label");
			fieldLabel.textContent = label;
			field.appendChild(fieldLabel);
			const colorInput = document.createElement("input");
			colorInput.type = "color";
			const hexInput = document.createElement("input");
			hexInput.type = "text";
			hexInput.spellcheck = false;
			const current = colors[key];
			const hex = typeof current === "string" && current ? cssColorToHex(current) : cssColorToHex(computedThemeColors()[key] as string);
			colorInput.value = hex;
			hexInput.value = hex;
			const setColor = (next: string): void => {
				const normalized = cssColorToHex(next);
				(colors[key] as string) = normalized;
				colorInput.value = normalized;
				hexInput.value = normalized;
				paint();
			};
			colorInput.oninput = () => setColor(colorInput.value);
			hexInput.onchange = () => setColor(hexInput.value);
			field.appendChild(colorInput);
			field.appendChild(hexInput);
			groupEl.appendChild(field);
		}
		colorFields.appendChild(groupEl);
	}
	wrapper.appendChild(colorFields);

	const alphas: Array<[string, "bg_alpha" | "row_alpha"]> = [
		["Panel opacity", "bg_alpha"],
		["Row / input opacity", "row_alpha"],
	];
	for (const [label, key] of alphas) {
		const row = document.createElement("div");
		row.className = "theme-alpha-row";
		const name = document.createElement("label");
		name.textContent = label;
		row.appendChild(name);
		const readout = document.createElement("span");
		readout.className = "settings-readout";
		readout.textContent = `${colors[key]}%`;
		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "5";
		slider.max = "100";
		slider.value = String(colors[key]);
		slider.oninput = () => {
			colors[key] = Number(slider.value);
			readout.textContent = `${colors[key]}%`;
			paint();
		};
		row.appendChild(slider);
		row.appendChild(readout);
		wrapper.appendChild(row);
	}

	const fontRow = document.createElement("div");
	fontRow.className = "settings-row";
	const fontLabel = document.createElement("label");
	fontLabel.textContent = "Font";
	fontRow.appendChild(fontLabel);
	const fontSelect = document.createElement("select");
	const fontChoices: Array<[string, string]> = [
		["", "Keep current"],
		['-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', "System"],
		['Tahoma, "MS Sans Serif", Geneva, sans-serif', "Tahoma"],
		['Georgia, "Times New Roman", serif', "Georgia"],
		["Arial, Helvetica, sans-serif", "Arial"],
		['"Arial Black", Impact, sans-serif', "Arial Black"],
		["ui-monospace, SFMono-Regular, Menlo, monospace", "Mono"],
		['"Times New Roman", Times, serif', "Times"],
		['"Segoe UI", sans-serif', "Segoe UI"],
	];
	for (const [value, label] of fontChoices) {
		const opt = document.createElement("option");
		opt.value = value;
		opt.textContent = label;
		opt.selected = colors.font_family === value || (value !== "" && colors.font_family.startsWith(value.split(",")[0]!));
		fontSelect.appendChild(opt);
	}
	fontSelect.onchange = () => {
		colors.font_family = fontSelect.value;
		paint();
	};
	fontRow.appendChild(fontSelect);
	wrapper.appendChild(fontRow);

	const metrics: Array<[string, keyof ThemeColors, number, number, string]> = [
		["Window corners", "window_radius", 0, 28, "px"],
		["Control corners", "radius", 0, 28, "px"],
		["Small corners", "radius_sm", 0, 20, "px"],
		["Type size", "font_size", 11, 20, "px"],
		["Type weight", "font_weight", 400, 800, ""],
		["Border width", "border_width", 0, 5, "px"],
		["Backdrop blur", "backdrop_blur", 0, 48, "px"],
		["Press inset", "press_offset", 0, 8, "px"],
		["Stack gap", "gap", 4, 20, "px"],
		["Side padding", "pad", 6, 24, "px"],
	];
	for (const [label, key, min, max, unit] of metrics) {
		const row = document.createElement("div");
		row.className = "theme-alpha-row";
		const name = document.createElement("label");
		name.textContent = label;
		row.appendChild(name);
		const readout = document.createElement("span");
		readout.className = "settings-readout";
		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = String(min);
		slider.max = String(max);
		slider.step = key === "font_weight" ? "100" : "1";
		slider.value = String(colors[key]);
		readout.textContent = `${colors[key]}${unit}`;
		slider.oninput = () => {
			(colors[key] as number) = Number(slider.value);
			readout.textContent = `${colors[key]}${unit}`;
			paint();
		};
		row.appendChild(slider);
		row.appendChild(readout);
		wrapper.appendChild(row);
	}

	const saveBtn = document.createElement("button");
	saveBtn.textContent = editing ? "Save theme" : "Save as new theme";
	saveBtn.onclick = async () => {
		const name = nameInput.value.trim();
		if (!name) {
			nameInput.focus();
			return;
		}
		const mode = modeSelect.value as "light" | "dark";
		if (editing) {
			await Store.updateCustomTheme(editing.id, name, mode, colors);
			customThemesCache = await Store.listCustomThemes();
			await setTheme(editing.id);
		} else {
			const created = await Store.addCustomTheme(name, mode, colors);
			customThemesCache = await Store.listCustomThemes();
			await setTheme(created.id);
		}
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
	editBtn.onclick = () => {
		void setTheme(theme.id).then(() => onEdit());
	};
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

function heading(text: string, keywords = ""): HTMLElement {
	const h = document.createElement("h3");
	h.textContent = text;
	h.id = sectionId(text);
	if (keywords) h.dataset.search = keywords;
	return h;
}

/** [visible label, exact heading text to jump to] — a short list of the sections worth a quick jump, not every single one. */
const SETTINGS_NAV: Array<[string, string]> = [
	["Look", "Appearance"],
	["Capture", "Capture behavior"],
	["Pins", "Pinned quick-access"],
	["Keys", "Double-shift bindings"],
	["Alerts", "Notifications"],
	["Dock", "Dock"],
	["Snips", "Snippet templates"],
	["Sync", "Sync"],
	["Data", "Data"],
];

function filterSettings(query: string): void {
	const q = query.trim();
	let heading: HTMLElement | null = null;
	let any = false;
	let sectionOpen = q === "";
	const flush = (): void => {
		if (heading) heading.classList.toggle("settings-hidden", q !== "" && !any);
	};
	for (const node of settingsView.children) {
		if (!(node instanceof HTMLElement)) continue;
		if (node.classList.contains("settings-nav-sticky")) continue;
		if (node.tagName === "H3") {
			flush();
			heading = node;
			any = false;
			const headingHay = `${node.textContent ?? ""} ${node.dataset.search ?? ""}`;
			sectionOpen = q === "" || settingsSearchMatches(q, headingHay);
			continue;
		}
		const hay = `${node.textContent ?? ""} ${node.dataset.search ?? ""}`;
		const match = q === "" || sectionOpen || settingsSearchMatches(q, hay);
		node.classList.toggle("settings-hidden", !match);
		if (match) any = true;
	}
	flush();
}

function buildSettingsNav(): HTMLElement {
	const sticky = document.createElement("div");
	sticky.className = "settings-nav-sticky";
	const search = document.createElement("input");
	search.className = "settings-search";
	search.type = "search";
	search.placeholder = "Search settings…";
	search.oninput = () => filterSettings(search.value);
	sticky.appendChild(search);
	const nav = document.createElement("div");
	nav.className = "settings-nav";
	for (const [label, target] of SETTINGS_NAV) {
		const btn = document.createElement("button");
		btn.className = "settings-nav-btn";
		btn.textContent = label;
		btn.onclick = () => document.getElementById(sectionId(target))?.scrollIntoView({ block: "start", behavior: "smooth" });
		nav.appendChild(btn);
	}
	sticky.appendChild(nav);
	const back = document.createElement("button");
	back.className = "settings-back";
	back.textContent = "Back";
	back.onclick = () => closeSettings();
	sticky.appendChild(back);
	return sticky;
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
	const firstOpen = settingsView.hidden;
	const savedScroll = firstOpen ? 0 : settingsView.scrollTop;
	const [current, templates, syncStatus, accessibilityTrusted] = await Promise.all([
		loadSettings(),
		Store.listTemplates(),
		Store.getSyncStatus(),
		Store.accessibilityTrusted(),
	]);
	settingsView.innerHTML = "";
	settingsView.appendChild(buildSettingsNav());

	settingsView.appendChild(heading("Appearance", "theme look color opacity palette font radius"));
	settingsView.appendChild(buildThemeRow(current));
	settingsView.appendChild(buildOpacityRow(current));
	for (const row of buildPanelSizeRows(current)) settingsView.appendChild(row);

	const customThemesDetails = document.createElement("details");
	customThemesDetails.className = "settings-collapsible";
	customThemesDetails.open = true;
	const customThemesSummary = document.createElement("summary");
	customThemesSummary.id = sectionId("Custom themes");
	customThemesSummary.textContent = "Customize theme";
	customThemesDetails.appendChild(customThemesSummary);
	const customThemesSection = document.createElement("div");
	const editingId = customThemesCache.some((t) => t.id === current.theme) ? current.theme : null;
	renderCustomThemesSection(customThemesSection, customThemesCache, editingId);
	customThemesDetails.appendChild(customThemesSection);
	settingsView.appendChild(customThemesDetails);

	settingsView.appendChild(heading("Capture behavior", "capture save silent paste highlight sort mode"));
	settingsView.appendChild(buildCaptureModeRow(current));
	settingsView.appendChild(buildHighlightSubmitRow(current));
	settingsView.appendChild(buildSortRow(current));
	for (const row of buildBehaviorRows(current)) settingsView.appendChild(row);
	settingsView.appendChild(buildExcludedAppsRow(current));
	settingsView.appendChild(buildCaptureImageRow());

	settingsView.appendChild(heading("Pinned quick-access", "pin pinned slot shortcut quick"));
	settingsView.appendChild(buildPinnedItemsSection(current));

	settingsView.appendChild(heading("Visibility", "dock menubar tray launch"));
	for (const row of buildVisibilityRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Double-shift bindings", "key shortcut binding shift tap hotkey"));
	settingsView.appendChild(buildAccessibilityStatusRow(accessibilityTrusted));
	settingsView.appendChild(buildBindingRow("Left Shift", "left", current));
	settingsView.appendChild(buildBindingRow("Right Shift", "right", current));

	settingsView.appendChild(heading("Fallback shortcuts", "shortcut hotkey key binding fallback accelerator"));
	settingsView.appendChild(buildShortcutRow("Toggle panel", "fallback_toggle", current));
	settingsView.appendChild(buildShortcutRow("Capture selection", "fallback_capture", current));
	settingsView.appendChild(buildShortcutRow("Capture image", "fallback_image", current));
	settingsView.appendChild(buildResetShortcutsRow(current));

	settingsView.appendChild(heading("Notifications", "toast notify alert sound icon"));
	for (const row of buildNotificationRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Dock", "dock notch pill recent edge position place"));
	for (const row of buildDockRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Snippet templates", "snippet template slash expand"));
	for (const template of templates) {
		settingsView.appendChild(buildTemplateRow(template));
	}
	settingsView.appendChild(buildAddTemplateForm());

	settingsView.appendChild(heading("Sync", "sync s3 folder backup encrypt cloud"));
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

	settingsView.appendChild(heading("Data", "data export update backup import"));
	settingsView.appendChild(buildExportRow());
	settingsView.appendChild(buildConfigBackupRow(current));
	settingsView.appendChild(await buildUpdatesRow());

	settingsView.hidden = false;
	list.hidden = true;
	metaBar.hidden = true;
	detailView.hidden = true;
	captureRow.hidden = true;
	settingsView.scrollTop = savedScroll;
	if (firstOpen) {
		requestAnimationFrame(() => settingsView.querySelector<HTMLInputElement>(".settings-search")?.focus());
	}
}

function closeSettings(): void {
	settingsView.hidden = true;
	list.hidden = false;
	metaBar.hidden = false;
	captureRow.hidden = false;
	if (settings) applyTheme(settings.theme);
	if (input.value.startsWith("/")) {
		input.value = "";
		selected = -1;
	}
	renderList();
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
window.setTimeout(() => {
	void Store.getSyncStatus().then((status) => {
		if (status.fallback_reason) {
			showStatusToast(`Using local storage: ${status.fallback_reason}`, 6000);
		}
	});
}, 1200);
