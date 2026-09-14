import { convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import {
	applyListDrag,
	applySort,
	buildListTabs,
	copyableItemText,
	detectKind,
	emptyTabCopy,
	extendRangeByIds,
	extractTags,
	filterItems,
	itemsForTab,
	nextListTab,
	formatRelativeTime,
	HELP_SHORTCUTS,
	lastToken,
	listDragNeedsSyntheticDown,
	listDragRowFromPoint,
	matchAtSuggestions,
	matchHashSuggestions,
	matchSlashSuggestions,
	matchSortSuggestions,
	matchThemeSuggestions,
	normalizeThemeColors,
	parseInlineMarkdown,
	parseSlashMode,
	parseUiCommand,
	pointerLeftWindow,
	rankForDrop,
	replaceLastToken,
	resolveCapture,
	slashSuggestionIsImmediate,
	type ListTab,
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
	openItemContextMenu,
	pointerOnScrollbar,
	stepLoadedSelection,
} from "./item-chrome";
import { Store, type CustomTheme, type HighlightSubmit, type HistoryEntry, type Item, type ItemKind, type Settings, type SortMode, type Template, type ToastPosition } from "./store";
import { applyCustomPalette, clearCustomPalette, normalizeTheme, THEMES } from "./themes";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";
type NotchEdge = "top" | "bottom" | "left" | "right" | "float";
type NotchAnchor = "start" | "center" | "end";
type ComposerPlace = "start" | "end";

const DEFAULT_ROW_HEIGHT = 36;

/** Standalone entry for the dock window — Tokitoki-style edge notch. */
function edgeFromPosition(position: ToastPosition): NotchEdge {
	if (position.startsWith("top_")) return "top";
	if (position.startsWith("bottom_")) return "bottom";
	if (position === "middle_left" || position.startsWith("left_")) return "left";
	if (position === "middle_right" || position.startsWith("right_")) return "right";
	return "float";
}

function anchorFromPosition(position: ToastPosition): NotchAnchor {
	switch (position) {
		case "top_left":
		case "top_mid_left":
		case "bottom_left":
		case "bottom_mid_left":
		case "left_top":
		case "left_upper":
		case "right_top":
		case "right_upper":
			return "start";
		case "top_right":
		case "top_mid_right":
		case "bottom_right":
		case "bottom_mid_right":
		case "left_bottom":
		case "left_lower":
		case "right_bottom":
		case "right_lower":
			return "end";
		default:
			return "center";
	}
}

function composerPlace(edge: NotchEdge, anchor: NotchAnchor): ComposerPlace {
	if (edge === "bottom") return "end";
	if ((edge === "left" || edge === "right") && anchor !== "start") return "end";
	return "start";
}

const RESIZE_HANDLES: { side: string; dir: ResizeDirection }[] = [
	{ side: "n", dir: "North" },
	{ side: "s", dir: "South" },
	{ side: "e", dir: "East" },
	{ side: "w", dir: "West" },
	{ side: "ne", dir: "NorthEast" },
	{ side: "nw", dir: "NorthWest" },
	{ side: "se", dir: "SouthEast" },
	{ side: "sw", dir: "SouthWest" },
];

const root = document.getElementById("dock-app")!;
root.innerHTML = `
	<div class="notch">
		<div class="notch-surface">
			<div class="notch-collapsed" title="Drag to move">
				<div class="notch-grip"></div>
			</div>
			<div class="notch-expanded">
				<div class="notch-rail-head">
					<div class="notch-tabs" role="tablist"></div>
					<span class="notch-header-count"></span>
				</div>
				<div class="notch-composer-slot">
					<form class="notch-composer">
						<input class="notch-composer-input" type="text" placeholder="Filter, /command, or add a note" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off" />
					</form>
				</div>
				<div class="notch-list"></div>
				<div class="notch-action-bar"></div>
			</div>
		</div>
	</div>
`;
const notch = root.querySelector<HTMLElement>(".notch")!;
const surface = root.querySelector<HTMLElement>(".notch-surface")!;
const collapsed = root.querySelector<HTMLElement>(".notch-collapsed")!;
const railHead = root.querySelector<HTMLElement>(".notch-rail-head")!;
const tabsEl = root.querySelector<HTMLElement>(".notch-tabs")!;
const headerCount = root.querySelector<HTMLElement>(".notch-header-count")!;
const list = root.querySelector<HTMLElement>(".notch-list")!;
list.addEventListener("scroll", () => {
	const total = tabItems().length;
	if (!notchShouldLoadMore(list.scrollTop, list.clientHeight, list.scrollHeight, loadedCount, total)) return;
	loadedCount = nextNotchLoadedCount(loadedCount, total);
	render();
});
const actionBar = root.querySelector<HTMLElement>(".notch-action-bar")!;
const composerSlot = root.querySelector<HTMLElement>(".notch-composer-slot")!;
const composer = root.querySelector<HTMLFormElement>(".notch-composer")!;
const composerInput = root.querySelector<HTMLInputElement>(".notch-composer-input")!;
const modeBadge = document.createElement("div");
modeBadge.className = "mode-badge";
modeBadge.hidden = true;
composerSlot.appendChild(modeBadge);
function showImagePreview(path: string): void {
	void Store.previewFile(path);
}

for (const id of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
	const el = document.createElement("div");
	el.className = "notch-drag";
	el.dataset.side = id;
	el.title = "Drag to move";
	el.addEventListener("pointerdown", beginDragFrom);
	surface.appendChild(el);
}

for (const handle of RESIZE_HANDLES) {
	const el = document.createElement("div");
	el.className = "notch-resize";
	el.dataset.side = handle.side;
	el.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		e.stopPropagation();
		pointerOrigin = null;
		void startResize(handle.dir);
	});
	surface.appendChild(el);
}

const tagFilterBar = document.createElement("div");
tagFilterBar.className = "tag-filter-bar";
tagFilterBar.hidden = true;
list.parentElement!.insertBefore(tagFilterBar, list);

function renderTabs(): void {
	const tabs = buildListTabs(items, settings?.separate_tag_tabs ?? true);
	if (!tabs.some((tab) => tab.id === currentTab)) currentTab = "recent";

	tabsEl.innerHTML = "";
	for (const tab of tabs) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.role = "tab";
		btn.className = "notch-tab";
		btn.dataset.tab = tab.id;
		btn.textContent = tab.label;
		btn.setAttribute("aria-selected", String(tab.id === currentTab));
		btn.addEventListener("pointerdown", beginDragFrom);
		btn.addEventListener("click", () => {
			if (arranging) return;
			if (currentTab === tab.id) return;
			currentTab = tab.id;
			selected = -1;
			loadedCount = Math.max(itemCount, NOTCH_PAGE_SIZE);
			multiSelected.clear();
			selectionAnchorId = null;
			invalidateFiltered();
			renderTabs();
			render();
		});
		tabsEl.appendChild(btn);
	}

	tagFilterBar.hidden = currentTab !== "tags";
	if (currentTab === "tags") {
		tagFilterBar.innerHTML = "";
		for (const tag of extractTags(items)) {
			const pill = document.createElement("button");
			pill.type = "button";
			pill.className = "tag-filter-pill";
			pill.classList.toggle("active", selectedTagFilters.has(tag));
			pill.textContent = `#${tag}`;
			pill.onclick = () => {
				if (selectedTagFilters.has(tag)) selectedTagFilters.delete(tag);
				else selectedTagFilters.add(tag);
				invalidateFiltered();
				renderTabs();
				render();
			};
			tagFilterBar.appendChild(pill);
		}
	}
}

let expanded = false;
let arranging = false;
let resizing = false;
let composerActive = false;
let cardDragging = false;
let pointerReorder: { id: string; from: number; over: number; x: number; y: number; live: boolean } | null = null;
let itemCount = 10;
let loadedCount = NOTCH_PAGE_SIZE;
let rowHeight = DEFAULT_ROW_HEIGHT;
let items: Item[] = [];
let templatesCache: Template[] = [];
let customThemesCache: CustomTheme[] = [];
let settings: Settings | null = null;
let currentTab: ListTab = "recent";
let selectedTagFilters = new Set<string>();
let selected = -1;
let editingId: string | null = null;
const multiSelected = new Set<string>();
let selectionAnchorId: string | null = null;
let pointerOrigin: { x: number; y: number } | null = null;
let resizeFinishTimer = 0;
let commandSuggestions: SlashSuggestion[] = [];
let themeSuggestions: ThemeChoice[] = [];
let sortSuggestions: Array<{ mode: SortMode; label: string }> = [];
let previewSnapshot: Settings | null = null;
let listFilterKey = "";
let lastHelpCategory = "";
let filteredCache: Item[] | null = null;
let hoveredId: string | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

const MODE_BADGE_LABELS: Partial<Record<SlashMode["type"], string>> = {
	theme: "THEME",
	light: "THEME",
	dark: "THEME",
	sort: "SORT",
	history: "HISTORY",
	help: "HELP",
};

function scopedItems(): Item[] {
	return itemsForTab(items, currentTab, selectedTagFilters);
}

function invalidateFiltered(): void {
	filteredCache = null;
}

function tabItems(): Item[] {
	if (!filteredCache) {
		filteredCache = applySort(filterItems(scopedItems(), composerInput.value), settings?.sort_mode ?? "manual");
	}
	return filteredCache;
}

function visibleItems(): Item[] {
	return tabItems().slice(0, loadedCount);
}

function allThemeChoices(): ThemeChoice[] {
	return [
		...THEMES.map((t) => ({ id: t.id, label: t.label, mode: t.mode })),
		...customThemesCache.map((t) => ({ id: t.id, label: t.name, mode: t.mode })),
	];
}

function applyTheme(themeId: string): void {
	const rootEl = document.documentElement;
	const custom = customThemesCache.find((t) => t.id === themeId);
	if (custom) {
		applyCustomPalette(rootEl, normalizeThemeColors(custom.colors), custom.mode);
	} else {
		clearCustomPalette(rootEl);
		rootEl.dataset.theme = normalizeTheme(themeId);
	}
	if (settings && settings.panel_opacity > 0) {
		rootEl.style.setProperty("--bg-alpha", `${settings.panel_opacity}%`);
	}
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
	invalidateFiltered();
}

function isPreviewMode(mode: SlashMode | null): boolean {
	return mode !== null && (mode.type === "theme" || mode.type === "light" || mode.type === "dark" || mode.type === "sort");
}

function composerSlashMode(): SlashMode | null {
	const raw = composerInput.value;
	return raw.startsWith("/") ? parseSlashMode(raw) : null;
}

function currentSuggestionCount(raw: string): number {
	if (raw.startsWith("/")) {
		const mode = parseSlashMode(raw);
		if (mode.type === "theme" || mode.type === "light" || mode.type === "dark") {
			const filterMode = mode.type === "light" ? "light" : mode.type === "dark" ? "dark" : undefined;
			return matchThemeSuggestions(mode.type === "theme" ? mode.query : "", allThemeChoices(), filterMode).length;
		}
		if (mode.type === "sort") return matchSortSuggestions(mode.query).length;
		if (mode.type === "history" || mode.type === "help") return 0;
		return matchSlashSuggestions(raw, templatesCache).length;
	}
	const partial = lastToken(raw);
	if (partial.startsWith("@")) return matchAtSuggestions(partial).length;
	if (partial.startsWith("#")) return matchHashSuggestions(partial, items).length;
	return tabItems().length;
}

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
	composerInput.classList.toggle("has-mode-badge", !!label);
}

async function actOnItem(item: Item): Promise<void> {
	if (item.kind === "link") {
		await open(item.text);
	} else if (item.kind === "image") {
		await Store.copyImageToClipboard(item.text);
	} else {
		const text = copyableItemText(item);
		await navigator.clipboard.writeText(text);
		await Store.noteOwnClipboardWrite(text);
	}
	await Store.logUsed(item.id);
}

/** Same Settings → "On Enter" as the main panel: copy, collapse, paste. */
async function applyNotchHighlightSubmit(openedLink: boolean): Promise<void> {
	const mode: HighlightSubmit = settings?.highlight_submit ?? "copy_hide_write";
	if (mode === "copy") return;
	if (mode === "copy_hide" || openedLink) {
		await Store.dockHideAndSubmit(false);
		return;
	}
	await Store.dockHideAndSubmit(true);
}

function fillMarkdown(target: HTMLElement, text: string): void {
	target.replaceChildren();
	for (const segment of parseInlineMarkdown(text)) {
		if (segment.type === "text") {
			target.appendChild(document.createTextNode(segment.text));
			continue;
		}
		const span = document.createElement("span");
		span.className = `md-${segment.type}`;
		span.textContent = segment.text;
		target.appendChild(span);
	}
}

function emptyCopy(): { title: string; body: string } {
	return emptyTabCopy(
		currentTab,
		Boolean(composerInput.value.trim()) && !composerInput.value.startsWith("/"),
		selectedTagFilters.size,
	);
}

async function shareItem(item: Item): Promise<void> {
	if (item.kind === "image") {
		await Store.revealInFinder(item.text);
		return;
	}
	const subject = encodeURIComponent("Shared from shiftshift");
	const body = encodeURIComponent(item.text);
	await open(`mailto:?subject=${subject}&body=${body}`);
}

function startNotchEdit(id: string): void {
	editingId = id;
	render();
}

function buildNotchEditInput(item: Item): HTMLElement {
	const editInput = document.createElement("input");
	editInput.className = "item-edit-input";
	editInput.value = item.text;
	const commit = async (): Promise<void> => {
		const next = editInput.value.trim();
		editingId = null;
		if (next && next !== item.text) {
			await Store.updateItemText(item.id, next);
		}
		await refresh();
	};
	editInput.onblur = () => void commit();
	editInput.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") void commit();
		if (e.key === "Escape") {
			editingId = null;
			render();
		}
	};
	queueMicrotask(() => editInput.focus());
	return editInput;
}

async function runNotchChromeAction(item: Item, id: string): Promise<void> {
	if (id === "bookmark") {
		await Store.toggleBookmarked(item.id);
		await refresh();
		return;
	}
	if (id === "todo") {
		const to: ItemKind = item.kind === "todo" ? "note" : "todo";
		await Store.setKind(item.id, to);
		await refresh();
		return;
	}
	if (id === "edit") {
		startNotchEdit(item.id);
		return;
	}
	if (id === "open") {
		if (item.kind !== "link") return;
		await actOnItem(item);
		return;
	}
	if (id === "share") {
		await shareItem(item);
		return;
	}
	if (id === "delete") {
		await Store.deleteItem(item.id);
		await refresh();
		return;
	}
	if (id === "select") {
		multiSelected.add(item.id);
		render();
		return;
	}
	if (id === "deselect") {
		multiSelected.delete(item.id);
		render();
		return;
	}
	if (id === "select_all") {
		for (const row of tabItems()) multiSelected.add(row.id);
		render();
		return;
	}
	if (id === "copy_selection" || id === "copy_selection_plain") {
		const ordered = items.filter((row) => multiSelected.has(row.id));
		const joined =
			id === "copy_selection_plain"
				? ordered.map(copyableItemText).join("\n")
				: ordered.map((row, index) => `${index + 1}. ${copyableItemText(row)}`).join("\n");
		await navigator.clipboard.writeText(joined);
		await Store.noteOwnClipboardWrite(joined);
		for (const row of ordered) await Store.logUsed(row.id);
		if (id !== "copy_selection_plain") {
			multiSelected.clear();
			selectionAnchorId = null;
		}
		render();
		return;
	}
	if (id === "bookmark_selection") {
		for (const row of items.filter((row) => multiSelected.has(row.id))) {
			await Store.toggleBookmarked(row.id);
		}
		await refresh();
		return;
	}
	if (id === "todo_selection") {
		for (const row of items.filter((row) => multiSelected.has(row.id) && row.kind !== "image")) {
			await Store.setKind(row.id, row.kind === "todo" ? "note" : "todo");
		}
		await refresh();
		return;
	}
	if (id === "delete_selection") {
		for (const row of items.filter((row) => multiSelected.has(row.id))) {
			await Store.deleteItem(row.id);
		}
		multiSelected.clear();
		selectionAnchorId = null;
		await refresh();
	}
}

function suggestionRow(index: number, icon: string, label: string, hint: string, onClick: () => void): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row suggestion-row";
	row.classList.toggle("selected", index === selected);
	row.onclick = onClick;
	const iconEl = document.createElement("div");
	iconEl.className = "item-icon";
	iconEl.textContent = icon;
	row.appendChild(iconEl);
	const text = document.createElement("div");
	text.className = "item-text";
	text.textContent = label;
	row.appendChild(text);
	if (hint) {
		const hintEl = document.createElement("div");
		hintEl.className = "suggestion-hint";
		hintEl.textContent = hint;
		row.appendChild(hintEl);
	}
	return row;
}

function completeAtToken(tag: string): void {
	composerInput.value = replaceLastToken(composerInput.value, `@${tag}`);
	selected = -1;
	composerInput.focus();
	render();
}

function completeHashToken(tag: string): void {
	composerInput.value = replaceLastToken(composerInput.value, `#${tag}`);
	selected = -1;
	composerInput.focus();
	render();
}

async function commitHighlightedSuggestion(): Promise<void> {
	const mode = composerSlashMode();
	if (mode && (mode.type === "theme" || mode.type === "light" || mode.type === "dark") && themeSuggestions[selected]) {
		await commitPreview();
	} else if (mode?.type === "sort" && sortSuggestions[selected]) {
		await commitPreview();
	}
	composerInput.value = "";
	selected = -1;
	render();
}

function renderHistoryEntry(entry: HistoryEntry): HTMLElement {
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

async function renderHistoryRows(query: string): Promise<void> {
	const entries = await Store.listHistory(200);
	const q = query.trim().toLowerCase();
	const matching = q ? entries.filter((e) => e.action.toLowerCase().includes(q) || (e.detail ?? "").toLowerCase().includes(q)) : entries;
	if (composerInput.value.trim() !== `/history ${query}`.trim()) return;
	list.innerHTML = "";
	if (matching.length === 0) {
		const empty = document.createElement("div");
		empty.className = "item-row";
		empty.textContent = "No history yet.";
		list.appendChild(empty);
		return;
	}
	for (const entry of matching) list.appendChild(renderHistoryEntry(entry));
}

function renderHelpRows(): void {
	lastHelpCategory = "";
	for (const entry of HELP_SHORTCUTS) {
		const row = document.createElement("div");
		row.className = "item-row help-row";
		const category = document.createElement("span");
		category.className = "help-category";
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
		list.appendChild(row);
	}
}

function renderComposerSuggestions(raw: string): boolean {
	if (raw.startsWith("/")) {
		const mode = parseSlashMode(raw);
		updateModeBadge(raw, mode);
		if (previewSnapshot !== null && !isPreviewMode(mode)) cancelPreview();
		list.innerHTML = "";
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
			themeSuggestions.forEach((theme, index) => {
				list.appendChild(
					suggestionRow(index, theme.mode === "light" ? "☀" : "☾", theme.label, theme.mode, () => {
						selected = index;
						void commitHighlightedSuggestion();
					}),
				);
			});
			return true;
		}
		if (mode.type === "sort") {
			sortSuggestions = matchSortSuggestions(mode.query);
			if (selected >= sortSuggestions.length) selected = sortSuggestions.length - 1;
			if (selected < 0 && sortSuggestions.length > 0) selected = 0;
			beginPreview();
			const picked = sortSuggestions[selected];
			if (picked && settings) settings.sort_mode = picked.mode;
			sortSuggestions.forEach((option, index) => {
				list.appendChild(
					suggestionRow(index, "↕", option.label, "", () => {
						selected = index;
						void commitHighlightedSuggestion();
					}),
				);
			});
			return true;
		}
		if (mode.type === "history") {
			void renderHistoryRows(mode.query);
			return true;
		}
		if (mode.type === "help") {
			renderHelpRows();
			return true;
		}
		commandSuggestions = matchSlashSuggestions(raw, templatesCache);
		if (selected >= commandSuggestions.length) selected = commandSuggestions.length - 1;
		commandSuggestions.forEach((suggestion, index) => {
			list.appendChild(
				suggestionRow(index, suggestion.kind === "template" ? "⚡" : "▸", `/${suggestion.name}`, suggestion.hint, () => {
					composerInput.value = `/${suggestion.name} `;
					selected = -1;
					composerInput.focus();
					render();
				}),
			);
		});
		return true;
	}
	const partial = lastToken(raw);
	if (partial.startsWith("@")) {
		if (previewSnapshot !== null) cancelPreview();
		updateModeBadge(raw, null);
		const suggestions = matchAtSuggestions(partial);
		if (selected >= suggestions.length) selected = suggestions.length - 1;
		list.innerHTML = "";
		suggestions.forEach((tag, index) => {
			list.appendChild(suggestionRow(index, "@", `@${tag.tag}`, tag.hint, () => completeAtToken(tag.tag)));
		});
		return true;
	}
	if (partial.startsWith("#")) {
		if (previewSnapshot !== null) cancelPreview();
		updateModeBadge(raw, null);
		const suggestions = matchHashSuggestions(partial, items);
		if (selected >= suggestions.length) selected = suggestions.length - 1;
		list.innerHTML = "";
		suggestions.forEach((tag, index) => {
			list.appendChild(suggestionRow(index, "#", `#${tag}`, "", () => completeHashToken(tag)));
		});
		return true;
	}
	if (previewSnapshot !== null) cancelPreview();
	updateModeBadge(raw, null);
	return false;
}

function render(): void {
	root.classList.toggle("is-open", expanded);
	notch.classList.toggle("notch-open", expanded);
	notch.classList.toggle("notch-arranging", arranging);
	root.style.setProperty("--notch-row", `${rowHeight}px`);
	root.dataset.composer = composerPlace(
		(root.dataset.edge as NotchEdge) || "top",
		(root.dataset.anchor as NotchAnchor) || "center",
	);

	if (arranging) {
		headerCount.textContent = formatHeaderCount(tabItems().length);
		list.replaceChildren();
		hoveredId = null;
		paintActionBar();
		return;
	}

	const raw = composerInput.value;
	if (raw !== listFilterKey) {
		listFilterKey = raw;
		loadedCount = Math.max(itemCount, NOTCH_PAGE_SIZE);
		multiSelected.clear();
		selectionAnchorId = null;
		invalidateFiltered();
	}
	if (renderComposerSuggestions(raw)) {
		headerCount.textContent = formatHeaderCount(scopedItems().length);
		hoveredId = null;
		paintActionBar();
		return;
	}

	const filtered = tabItems();
	loadedCount = Math.min(Math.max(loadedCount, Math.max(itemCount, NOTCH_PAGE_SIZE)), Math.max(filtered.length, 0));
	const visible = filtered.slice(0, loadedCount);
	if (selected >= visible.length) selected = visible.length - 1;

	headerCount.textContent = formatHeaderCount(filtered.length);
	for (const btn of tabsEl.querySelectorAll<HTMLButtonElement>(".notch-tab")) {
		btn.setAttribute("aria-selected", String(btn.dataset.tab === currentTab));
	}

	const scrollTop = list.scrollTop;
	list.innerHTML = "";
	if (visible.length === 0) {
		const empty = document.createElement("div");
		empty.className = "notch-empty";
		const title = document.createElement("div");
		title.className = "notch-empty-title";
		title.textContent = emptyCopy().title;
		const copy = document.createElement("div");
		copy.className = "notch-empty-copy";
		copy.textContent = emptyCopy().body;
		empty.appendChild(title);
		empty.appendChild(copy);
		list.appendChild(empty);
		hoveredId = null;
		paintActionBar();
		return;
	}

	visible.forEach((item, index) => {
		const row = document.createElement("div");
		row.className = "notch-card";
		row.role = "button";
		row.tabIndex = 0;
		row.dataset.kind = item.kind;
		row.dataset.done = String(item.done);
		row.dataset.id = item.id;
		row.dataset.dragIndex = String(index);
		row.title = item.text;
		row.classList.toggle("is-selected", index === selected);
		row.classList.toggle("multi-selected", multiSelected.has(item.id));

		if (item.kind === "todo") {
			const mark = document.createElement("span");
			mark.className = "notch-card-mark";
			mark.dataset.check = item.done ? "true" : "false";
			mark.onclick = async (e) => {
				e.stopPropagation();
				await Store.toggleDone(item.id);
				await refresh();
			};
			row.appendChild(mark);
		}

		if (editingId === item.id) {
			row.appendChild(buildNotchEditInput(item));
		} else if (item.kind === "image") {
			const thumb = document.createElement("img");
			thumb.className = "notch-card-preview";
			thumb.src = convertFileSrc(item.text);
			thumb.alt = "";
			thumb.draggable = false;
			row.appendChild(thumb);
		} else if (item.kind === "link") {
			const link = document.createElement("a");
			link.className = "notch-card-text notch-card-link";
			link.href = item.text;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			link.textContent = item.text.split("\n")[0]!.trim() || "(untitled)";
			link.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (cardDragging) return;
				void actOnItem(item);
			};
			row.appendChild(link);
		} else {
			const label = document.createElement("span");
			label.className = "notch-card-text";
			fillMarkdown(label, item.text.split("\n")[0]!.trim() || "(untitled)");
			row.appendChild(label);
		}

		if (editingId !== item.id) {
			const meta = document.createElement("span");
			meta.className = "notch-card-meta";
			meta.textContent = formatRelativeTime(item.created_at);
			row.appendChild(meta);
		}

		row.addEventListener(
			"pointerdown",
			(e) => {
				if (e.button !== 0 || e.altKey) return;
				if (pointerOnScrollbar(list, e.clientX)) return;
				if (e.target instanceof Element && e.target.closest(".item-action, .item-edit-input, .notch-card-mark, .notch-card-link")) return;
				e.stopPropagation();
				pointerOrigin = null;
				pointerReorder = applyListDrag(null, { type: "down", id: item.id, index, x: e.clientX, y: e.clientY }).state;
				try {
					row.setPointerCapture(e.pointerId);
				} catch {
					/* notch is not focusable — capture can throw */
				}
			},
			true,
		);
		row.addEventListener("contextmenu", (e) => {
			openItemContextMenu(
				e,
				itemContextEntries(item, { inSelection: multiSelected.has(item.id), selectionCount: multiSelected.size }),
				(actionId) => {
					void runNotchChromeAction(item, actionId);
				},
			);
		});
		row.addEventListener("pointerenter", () => {
			hoveredId = item.id;
			paintActionBar();
		});
		row.addEventListener("pointerleave", () => {
			if (hoveredId !== item.id) return;
			hoveredId = null;
			paintActionBar();
		});
		row.addEventListener("click", (e) => {
			if (cardDragging || editingId === item.id) return;
			if (e.target instanceof Element && e.target.closest(".item-action, .notch-card-mark, .notch-card-link")) return;
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
				paintSelection();
				return;
			}
			render();
			void actOnItem(item);
		});
		list.appendChild(row);
	});

	if (selected >= 0 && list.children[selected]) {
		list.children[selected]!.scrollIntoView({ block: "nearest" });
	} else {
		list.scrollTop = scrollTop;
	}
	paintActionBar();
}

function actionBarItem(): Item | null {
	const filtered = tabItems();
	if (hoveredId) return filtered.find((item) => item.id === hoveredId) ?? null;
	if (selected >= 0) return filtered[selected] ?? null;
	return null;
}

function paintActionBar(): void {
	const item = actionBarItem();
	actionBar.replaceChildren();
	if (!item || editingId === item.id) {
		actionBar.classList.add("is-empty");
		actionBar.textContent = "⌘B bookmark  ·  ⌘C copy  ·  ⌘⌫ delete";
		return;
	}
	actionBar.classList.remove("is-empty");
	actionBar.appendChild(
		buildHoverActions(
			item,
			(actionId) => {
				void runNotchChromeAction(item, actionId);
			},
			() => cardDragging,
		),
	);
}

function paintSelection(): void {
	for (const row of list.querySelectorAll<HTMLElement>(".notch-card")) {
		const index = Number(row.dataset.dragIndex);
		row.classList.toggle("is-selected", index === selected);
		const id = row.dataset.id;
		row.classList.toggle("multi-selected", !!id && multiSelected.has(id));
	}
	list.querySelector(".notch-card.is-selected")?.scrollIntoView({ block: "nearest" });
	paintActionBar();
}

function toggleNotchMulti(): void {
	const visible = visibleItems();
	if (selected < 0 || !visible[selected]) return;
	const id = visible[selected]!.id;
	if (multiSelected.has(id)) multiSelected.delete(id);
	else multiSelected.add(id);
	selectionAnchorId = id;
	paintSelection();
}

function applyComposerSpellcheck(enabled: boolean): void {
	composerInput.spellcheck = enabled;
	composerInput.autocomplete = "off";
	composerInput.setAttribute("autocorrect", enabled ? "on" : "off");
	composerInput.setAttribute("autocapitalize", enabled ? "sentences" : "off");
}

function moveNotchSelection(delta: number): void {
	const total = tabItems().length;
	const before = loadedCount;
	const next = stepLoadedSelection(selected, loadedCount, total, delta);
	selected = next.selected;
	loadedCount = next.loaded;
	if (loadedCount !== before || list.querySelectorAll(".notch-card").length !== Math.min(loadedCount, total)) {
		render();
		return;
	}
	paintSelection();
}

function applyExpanded(next: boolean): void {
	if (expanded === next) return;
	expanded = next;
	if (!next) {
		composerActive = false;
		selected = -1;
		composerInput.blur();
		composerInput.value = "";
		if (previewSnapshot !== null) cancelPreview();
	}
	render();
}

async function refresh(): Promise<void> {
	if (refreshInFlight) {
		refreshQueued = true;
		return refreshInFlight;
	}
	refreshInFlight = (async () => {
		do {
			refreshQueued = false;
			const [nextSettings, nextItems, nextTemplates, nextThemes] = await Promise.all([
				Store.getSettings(),
				Store.listItems(),
				Store.listTemplates(),
				Store.listCustomThemes(),
			]);
			settings = nextSettings;
			applyComposerSpellcheck(nextSettings.input_spellcheck);
			items = nextItems;
			templatesCache = nextTemplates;
			customThemesCache = nextThemes;
			invalidateFiltered();
			itemCount = Math.max(1, nextSettings.dock_item_count || 10);
			rowHeight = nextSettings.dock_row_height > 0 ? nextSettings.dock_row_height : DEFAULT_ROW_HEIGHT;
			root.dataset.edge = edgeFromPosition(nextSettings.dock_position);
			root.dataset.anchor = anchorFromPosition(nextSettings.dock_position);
			if (previewSnapshot === null) applyTheme(nextSettings.theme);
			renderTabs();
			render();
		} while (refreshQueued);
	})();
	try {
		await refreshInFlight;
	} finally {
		refreshInFlight = null;
	}
}
void refresh();

listen("refresh", () => void refresh());
listen<boolean>("dock-set-expanded", (event) => {
	applyExpanded(event.payload);
	if (event.payload) void refresh();
});

async function startResize(dir: ResizeDirection): Promise<void> {
	resizing = true;
	await Store.beginDockResize();
	await getCurrentWindow().startResizeDragging(dir);
}

function scheduleFinishResize(): void {
	window.clearTimeout(resizeFinishTimer);
	resizeFinishTimer = window.setTimeout(() => {
		if (!resizing) return;
		resizing = false;
		void Store.finishDockResize();
	}, 160);
}

void getCurrentWindow().onResized(() => {
	if (!resizing) return;
	scheduleFinishResize();
});

function beginDragFrom(e: PointerEvent): void {
	if (e.button !== 0 || resizing || cardDragging) return;
	pointerOrigin = { x: e.screenX, y: e.screenY };
}

root.addEventListener("selectstart", (e) => {
	if (e.target === composerInput) return;
	e.preventDefault();
});
collapsed.addEventListener("pointerdown", beginDragFrom);
railHead.addEventListener("pointerdown", beginDragFrom);

function beginExternalCardDrag(id: string): void {
	const current = items.find((item) => item.id === id);
	pointerReorder = null;
	clearCardMarks();
	window.setTimeout(() => {
		cardDragging = false;
	}, 0);
	if (current) void Store.startItemDrag(current.kind, copyableItemText(current));
}

function clearCardMarks(): void {
	for (const el of list.querySelectorAll(".is-drop-before, .is-drop-after, .is-dragging")) {
		el.classList.remove("is-drop-before", "is-drop-after", "is-dragging");
	}
}

function markCardOver(overIndex: number): void {
	clearCardMarks();
	const rows = [...list.querySelectorAll<HTMLElement>(".notch-card[data-drag-index]")];
	rows.find((el) => el.dataset.id === pointerReorder?.id)?.classList.add("is-dragging");
	const target = rows.find((el) => Number(el.dataset.dragIndex) === overIndex);
	target?.classList.add(overIndex > (pointerReorder?.from ?? 0) ? "is-drop-after" : "is-drop-before");
}

document.addEventListener("pointerleave", () => {
	const next = applyListDrag(pointerReorder, { type: "leave" });
	pointerReorder = next.state;
	if (next.effect.type === "external") beginExternalCardDrag(next.effect.id);
});

window.addEventListener("pointermove", (e) => {
	if (!pointerReorder && listDragNeedsSyntheticDown(null, e.buttons)) {
		const row = listDragRowFromPoint(e.clientX, e.clientY);
		const id = row?.dataset.id;
		const index = row ? Number(row.dataset.dragIndex) : Number.NaN;
		const under = document.elementFromPoint(e.clientX, e.clientY);
		if (pointerOnScrollbar(list, e.clientX)) {
			/* scrollbar click */
		} else if (under instanceof Element && under.closest(".item-action, .item-edit-input, .notch-card-mark")) {
			/* delete / todo mark keep their own press */
		} else if (row && id && !Number.isNaN(index)) {
			pointerOrigin = null;
			pointerReorder = applyListDrag(null, { type: "down", id, index, x: e.clientX, y: e.clientY }).state;
			try {
				row.setPointerCapture(e.pointerId);
			} catch {
				/* notch is not focusable */
			}
		}
	}
	if (pointerReorder) {
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
		cardDragging = true;
		if (next.effect.type === "external") {
			beginExternalCardDrag(next.effect.id);
			return;
		}
		if (next.effect.type === "reorder") markCardOver(next.effect.overIndex);
		return;
	}
	if (!pointerOrigin || arranging || resizing || cardDragging) return;
	if (Math.hypot(e.screenX - pointerOrigin.x, e.screenY - pointerOrigin.y) < 16) return;
	arranging = true;
	notch.classList.add("notch-arranging");
	list.replaceChildren();
	void (async () => {
		await Store.prepareDockDrag();
		await getCurrentWindow().startDragging();
	})();
});

window.addEventListener("pointerup", () => {
	if (pointerReorder) {
		const next = applyListDrag(pointerReorder, { type: "up" });
		pointerReorder = next.state;
		clearCardMarks();
		window.setTimeout(() => {
			cardDragging = false;
		}, 0);
		if (next.effect.type === "commit") {
			const { id, from, over } = next.effect;
			const visible = visibleItems();
			const rank = rankForDrop(visible, id, over > from ? over + 1 : over);
			void (async () => {
				await Store.setRank(id, rank);
				await refresh();
				const nextSelected = visibleItems().findIndex((item) => item.id === id);
				if (nextSelected >= 0) selected = nextSelected;
				render();
			})();
		}
		return;
	}
	pointerOrigin = null;
	if (resizing) {
		scheduleFinishResize();
		return;
	}
	if (!arranging) return;
	void Store.finishDockArrange();
});

window.addEventListener("pointercancel", (e) => {
	const left = pointerLeftWindow(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
	if (left || pointerReorder?.live) {
		const next = applyListDrag(pointerReorder, { type: "leave" });
		pointerReorder = next.state;
		if (next.effect.type === "external") beginExternalCardDrag(next.effect.id);
		return;
	}
	pointerReorder = null;
	clearCardMarks();
	cardDragging = false;
});

listen("dock-arrange-start", () => {
	arranging = true;
	render();
});
listen("dock-arrange-end", () => {
	arranging = false;
	void refresh();
});

async function dismissComposer(): Promise<void> {
	composerActive = false;
	selected = -1;
	composerInput.blur();
	composerInput.value = "";
	if (previewSnapshot !== null) cancelPreview();
	await Store.setDockComposer(false);
	await Store.dockSetExpanded(false);
}

async function pinComposer(): Promise<void> {
	if (composerActive) return;
	composerActive = true;
	await Store.setDockComposer(true);
}

function cycleTab(delta: number): void {
	const tabs = buildListTabs(items, settings?.separate_tag_tabs ?? true);
	currentTab = nextListTab(tabs, currentTab, delta);
	selected = -1;
	loadedCount = Math.max(itemCount, NOTCH_PAGE_SIZE);
	multiSelected.clear();
	selectionAnchorId = null;
	invalidateFiltered();
	renderTabs();
	render();
}

function extendNotchSelection(delta: number): void {
	const filtered = tabItems();
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
	if (selected >= loadedCount) loadedCount = selected + 1;
	if (list.querySelectorAll(".notch-card").length === Math.min(loadedCount, filtered.length)) {
		paintSelection();
		return;
	}
	render();
}

async function handleNotchSlashEnter(raw: string): Promise<void> {
	const uiCommand = parseUiCommand(raw);
	if (uiCommand?.type === "open-settings") {
		composerInput.value = "";
		selected = -1;
		render();
		await Store.showPanel();
		await emit("open-settings");
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
			composerInput.value = `/${pick.name}`;
			selected = -1;
			await handleNotchSlashEnter(`/${pick.name}`);
			return;
		}
		composerInput.value = `/${pick.name} `;
		selected = -1;
		render();
		return;
	}
	const captured = resolveCapture(raw, templatesCache);
	await Store.addItem(captured.text, captured.kind ?? detectKind(captured.text));
	composerInput.value = "";
	selected = -1;
	await refresh();
}

async function saveComposerText(raw: string, copy = false): Promise<void> {
	const captured = resolveCapture(raw, templatesCache);
	const text = captured.text;
	const item = await Store.addItem(text, captured.kind ?? detectKind(text));
	if (copy) {
		const copiedText = copyableItemText({ kind: item.kind, text });
		await navigator.clipboard.writeText(copiedText);
		await Store.noteOwnClipboardWrite(copiedText);
		await Store.logUsed(item.id);
	}
	composerInput.value = "";
	selected = -1;
	await refresh();
}

composerInput.addEventListener("focus", () => {
	void pinComposer();
});

composer.addEventListener("submit", (e) => {
	e.preventDefault();
});

composerInput.addEventListener("keydown", (e) => {
	const visible = visibleItems();
	const raw = composerInput.value;
	const empty = raw.trim() === "";
	const slashMode = composerSlashMode();
	const lastWord = !raw.startsWith("/") ? lastToken(raw) : "";
	const inAtMode = lastWord.startsWith("@");
	const inHashMode = lastWord.startsWith("#");
	const suggestionCount = currentSuggestionCount(raw);
	const inSuggest = raw.startsWith("/") || inAtMode || inHashMode;

	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		if (previewSnapshot !== null) {
			cancelPreview();
			composerInput.value = "";
			selected = -1;
			render();
			return;
		}
		if (multiSelected.size > 0) {
			multiSelected.clear();
			selectionAnchorId = null;
			render();
			return;
		}
		if (selected >= 0) {
			selected = -1;
			render();
			return;
		}
		if (raw) {
			composerInput.value = "";
			render();
			return;
		}
		void dismissComposer();
		return;
	}

	if (e.key === "Tab") {
		if (slashMode?.type === "commands") {
			e.preventDefault();
			const suggestions = matchSlashSuggestions(raw, templatesCache);
			const pick = selected >= 0 ? suggestions[selected] : suggestions[0];
			if (pick) {
				composerInput.value = `/${pick.name} `;
				selected = -1;
				render();
			}
			return;
		}
		if (
			slashMode &&
			(slashMode.type === "theme" || slashMode.type === "light" || slashMode.type === "dark" || slashMode.type === "sort")
		) {
			e.preventDefault();
			void commitHighlightedSuggestion();
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
			const rows = tabItems();
			const highlighted = selected >= 0 ? rows[selected] : undefined;
			const pick =
				highlighted && highlighted.kind !== "image" ? highlighted : rows.find((row) => row.kind !== "image");
			if (pick) {
				composerInput.value = pick.text;
				selected = 0;
				render();
			}
			return;
		}
		e.preventDefault();
		cycleTab(e.shiftKey ? -1 : 1);
		return;
	}

	if (e.altKey && empty && selected >= 0 && visible[selected] && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
		e.preventDefault();
		void pinComposer();
		const movedId = visible[selected]!.id;
		const toIndex = e.key === "ArrowUp" ? selected - 1 : selected + 2;
		if (e.key === "ArrowUp" && selected <= 0) return;
		if (e.key === "ArrowDown" && selected >= visible.length - 1) return;
		const rank = rankForDrop(visible, movedId, toIndex);
		void (async () => {
			await Store.setRank(movedId, rank);
			await refresh();
			const next = visibleItems().findIndex((item) => item.id === movedId);
			if (next >= 0) selected = next;
			render();
		})();
		return;
	}

	if (e.shiftKey && empty && !inSuggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
		e.preventDefault();
		void pinComposer();
		extendNotchSelection(e.key === "ArrowDown" ? 1 : -1);
		return;
	}

	if (e.key === "ArrowDown") {
		e.preventDefault();
		void pinComposer();
		if (inSuggest) {
			if (suggestionCount === 0) return;
			selected = selected < 0 ? 0 : (selected + 1) % suggestionCount;
			render();
			return;
		}
		moveNotchSelection(1);
		return;
	}

	if (e.key === "ArrowUp") {
		e.preventDefault();
		void pinComposer();
		if (inSuggest) {
			if (suggestionCount === 0) return;
			selected = selected < 0 ? suggestionCount - 1 : (selected - 1 + suggestionCount) % suggestionCount;
			render();
			return;
		}
		moveNotchSelection(-1);
		return;
	}

	if (e.key === "ArrowLeft" && empty && selected >= 0) {
		e.preventDefault();
		selected = -1;
		paintSelection();
		return;
	}

	if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && empty && selected < 0) {
		e.preventDefault();
		cycleTab(e.key === "ArrowRight" ? 1 : -1);
		return;
	}

	if (e.key === " " && empty && selected >= 0 && visible[selected] && ((e.ctrlKey && !e.metaKey) || multiSelected.size > 0)) {
		e.preventDefault();
		toggleNotchMulti();
		return;
	}

	if (e.key === " " && empty && selected >= 0 && visible[selected]?.kind === "todo") {
		e.preventDefault();
		void (async () => {
			await Store.toggleDone(visible[selected]!.id);
			await refresh();
		})();
		return;
	}

	const modKey = e.metaKey || e.ctrlKey;
	if (modKey && (e.key === "Backspace" || e.key === "Delete") && empty && multiSelected.size > 0) {
		e.preventDefault();
		const any = items.find((item) => multiSelected.has(item.id));
		if (any) void runNotchChromeAction(any, "delete_selection");
		return;
	}
	if (modKey && (e.key === "Backspace" || e.key === "Delete") && empty && selected >= 0 && visible[selected]) {
		e.preventDefault();
		void (async () => {
			await Store.deleteItem(visible[selected]!.id);
			selected = Math.min(selected, visible.length - 2);
			await refresh();
		})();
		return;
	}
	if (modKey && e.key.toLowerCase() === "b" && multiSelected.size > 0) {
		e.preventDefault();
		const any = items.find((item) => multiSelected.has(item.id));
		if (any) void runNotchChromeAction(any, "bookmark_selection");
		return;
	}
	if (modKey && e.key.toLowerCase() === "b" && selected >= 0 && visible[selected]) {
		e.preventDefault();
		void (async () => {
			await Store.toggleBookmarked(visible[selected]!.id);
			await refresh();
		})();
		return;
	}
	if (modKey && e.key.toLowerCase() === "t" && multiSelected.size > 0) {
		e.preventDefault();
		const any = items.find((item) => multiSelected.has(item.id));
		if (any) void runNotchChromeAction(any, "todo_selection");
		return;
	}
	if (modKey && e.key.toLowerCase() === "t" && selected >= 0 && visible[selected] && visible[selected]!.kind !== "image") {
		e.preventDefault();
		void (async () => {
			const current = visible[selected]!;
			await Store.setKind(current.id, current.kind === "todo" ? "note" : "todo");
			await refresh();
		})();
		return;
	}
	if (modKey && e.key.toLowerCase() === "e" && selected >= 0 && visible[selected] && visible[selected]!.kind !== "image") {
		e.preventDefault();
		startNotchEdit(visible[selected]!.id);
		return;
	}
	if (modKey && e.key.toLowerCase() === "o" && selected >= 0 && visible[selected]?.kind === "link") {
		e.preventDefault();
		void runNotchChromeAction(visible[selected]!, "open");
		return;
	}
	if (modKey && e.shiftKey && e.key.toLowerCase() === "s" && selected >= 0 && visible[selected]) {
		e.preventDefault();
		void shareItem(visible[selected]!);
		return;
	}
	if (modKey && e.key.toLowerCase() === "c" && empty) {
		e.preventDefault();
		if (multiSelected.size > 0) {
			const any = items.find((item) => multiSelected.has(item.id));
			if (any) void runNotchChromeAction(any, "copy_selection_plain");
			return;
		}
		if (selected >= 0 && visible[selected]) void actOnItem(visible[selected]!);
		return;
	}

	if (e.key !== "Enter") return;
	e.preventDefault();

	if (slashMode && slashMode.type !== "commands") {
		if (slashMode.type === "history" || slashMode.type === "help") {
			composerInput.value = "";
			selected = -1;
			render();
		} else {
			void commitHighlightedSuggestion();
		}
		return;
	}

	if (inAtMode) {
		const suggestions = matchAtSuggestions(lastWord);
		if (selected >= 0 && suggestions[selected]) completeAtToken(suggestions[selected]!.tag);
		return;
	}

	if (inHashMode) {
		const suggestions = matchHashSuggestions(lastWord, items);
		if (selected >= 0 && suggestions[selected]) completeHashToken(suggestions[selected]!);
		return;
	}

	const trimmed = raw.trim();
	if (e.shiftKey || modKey) {
		if (trimmed) void saveComposerText(trimmed, e.shiftKey && !modKey);
		return;
	}
	if (trimmed.startsWith("/")) {
		void handleNotchSlashEnter(trimmed);
		return;
	}
	if (multiSelected.size > 0) {
		const any = items.find((item) => multiSelected.has(item.id));
		if (any) {
			void (async () => {
				await runNotchChromeAction(any, "copy_selection");
				await applyNotchHighlightSubmit(false);
			})();
		}
		return;
	}
	if (selected >= 0 && visible[selected]) {
		void (async () => {
			const item = visible[selected]!;
			await actOnItem(item);
			await applyNotchHighlightSubmit(item.kind === "link");
		})();
		return;
	}
	if (trimmed) void saveComposerText(trimmed);
});

composerInput.addEventListener("input", () => {
	const count = currentSuggestionCount(composerInput.value);
	selected = count > 0 ? 0 : -1;
	render();
});

window.addEventListener("keydown", (e) => {
	if (e.key !== "Escape" || !composerActive) return;
	e.preventDefault();
	void dismissComposer();
});

window.addEventListener("blur", () => {
	if (resizing) {
		resizing = false;
		void Store.finishDockResize();
		return;
	}
	if (arranging) {
		void Store.finishDockArrange();
		return;
	}
	if (composerActive) void dismissComposer();
});
