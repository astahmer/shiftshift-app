import { fuzzyMatch } from "./capture-logic";
import type { Item } from "./store";

export function formatHeaderCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) {
		const tenths = Math.round(n / 100);
		return `${tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)}k`;
	}
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	const tenths = Math.round(n / 100_000);
	return `${tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)}M`;
}

export function pointerOnScrollbar(el: HTMLElement, clientX: number): boolean {
	return clientX >= el.getBoundingClientRect().right - 10;
}

export const NOTCH_PAGE_SIZE = 40;

export function nextNotchLoadedCount(
	loaded: number,
	total: number,
	page = NOTCH_PAGE_SIZE,
): number {
	return Math.min(total, Math.max(loaded, 0) + page);
}

/**
 * Arrow through a paged list without jumping to the last of 10k items.
 * Down past the loaded window grows by a page; up from the first row wraps
 * to the last *loaded* row, not the last item in the store.
 */
export function stepLoadedSelection(
	selected: number,
	loaded: number,
	total: number,
	delta: number,
	page = NOTCH_PAGE_SIZE,
): { selected: number; loaded: number } {
	if (total <= 0) return { selected: -1, loaded: 0 };
	let nextLoaded = Math.min(Math.max(loaded, 0), total);
	if (nextLoaded === 0) nextLoaded = Math.min(page, total);
	if (selected < 0) {
		return delta > 0
			? { selected: 0, loaded: nextLoaded }
			: { selected: nextLoaded - 1, loaded: nextLoaded };
	}
	const next = selected + delta;
	if (next >= nextLoaded) {
		if (nextLoaded < total) {
			return { selected: nextLoaded, loaded: Math.min(total, nextLoaded + page) };
		}
		return { selected: 0, loaded: nextLoaded };
	}
	if (next < 0) return { selected: nextLoaded - 1, loaded: nextLoaded };
	return { selected: next, loaded: nextLoaded };
}

export function notchShouldLoadMore(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	loaded: number,
	total: number,
	threshold = 48,
): boolean {
	if (loaded >= total) return false;
	return scrollTop + clientHeight >= scrollHeight - threshold;
}

export type HoverActionId = "preview" | "bookmark" | "todo" | "edit" | "open" | "share" | "delete";

export interface HoverActionDef {
	id: HoverActionId;
	title: string;
	glyph: string;
	hint: string;
}

export function hoverActionDefs(item: Item): HoverActionDef[] {
	const actions: HoverActionDef[] = [
		{ id: "preview", title: "Preview", glyph: "⌕", hint: "⇧→" },
		{ id: "bookmark", title: "Bookmark", glyph: item.bookmarked ? "★" : "☆", hint: "⌘B" },
	];
	if (item.kind === "link") {
		actions.push({ id: "open", title: "Open externally", glyph: "↗", hint: "⌘O" });
	}
	if (item.kind !== "image") {
		const isTodo = item.kind === "todo";
		actions.push({
			id: "todo",
			title: isTodo ? "Remove from todos" : "Convert to todo",
			glyph: isTodo ? "▢" : "☑",
			hint: "⌘T",
		});
		actions.push({ id: "edit", title: "Edit", glyph: "✎", hint: "⌘E" });
	}
	actions.push({ id: "share", title: "Share", glyph: "⤴", hint: "⌘⇧S" });
	actions.push({ id: "delete", title: "Delete", glyph: "🗑", hint: "⌫" });
	return actions;
}

export type ContextEntry =
	| { type: "sep" }
	| { type: "item"; id: string; label: string; hint?: string };

export function itemContextEntries(
	item: Item,
	opts: { inSelection: boolean; selectionCount: number },
): ContextEntry[] {
	const entries: ContextEntry[] = hoverActionDefs(item).map((action) => ({
		type: "item" as const,
		id: action.id,
		label: action.title,
		hint: action.hint,
	}));
	entries.push({ type: "sep" });
	entries.push(
		opts.inSelection
			? { type: "item", id: "deselect", label: "Remove from selection" }
			: { type: "item", id: "select", label: "Add to selection", hint: "⌃Space" },
	);
	entries.push({ type: "item", id: "select_all", label: "Select all" });
	if (opts.selectionCount > 0) {
		entries.push({ type: "sep" });
		entries.push({
			type: "item",
			id: "copy_selection",
			label: `Copy selection (${opts.selectionCount})`,
			hint: "⏎",
		});
		entries.push({
			type: "item",
			id: "bookmark_selection",
			label: "Bookmark selected",
			hint: "⌘B",
		});
		entries.push({
			type: "item",
			id: "todo_selection",
			label: "Convert selected to todos",
			hint: "⌘T",
		});
		entries.push({ type: "item", id: "tag_selection", label: "Tag selected..." });
		entries.push({ type: "item", id: "delete_selection", label: "Delete selected", hint: "⌘⌫" });
	}
	return entries;
}

export function buildHoverActions(
	item: Item,
	onAction: (id: HoverActionId, event: MouseEvent) => void,
	isBusy?: () => boolean,
): HTMLElement {
	const actions = document.createElement("div");
	actions.className = "item-actions";
	for (const def of hoverActionDefs(item)) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `item-action item-${def.id}`;
		button.title = def.title;
		button.setAttribute("aria-label", def.title);
		button.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		button.onclick = (event) => {
			event.stopPropagation();
			if (isBusy?.()) {
				event.preventDefault();
				return;
			}
			onAction(def.id, event);
		};
		const hint = document.createElement("span");
		hint.className = "item-action-hint";
		hint.textContent = def.hint;
		button.appendChild(hint);
		const icon = document.createElement("span");
		icon.textContent = def.glyph;
		button.appendChild(icon);
		actions.appendChild(button);
	}
	return actions;
}

let openMenu: HTMLElement | null = null;

export function closeItemContextMenu(): void {
	openMenu?.remove();
	openMenu = null;
}

export function openItemContextMenu(
	event: MouseEvent,
	entries: ContextEntry[],
	onPick: (id: string) => void,
): void {
	event.preventDefault();
	closeItemContextMenu();
	const menu = document.createElement("div");
	menu.className = "item-context-menu";
	menu.role = "menu";
	for (const entry of entries) {
		if (entry.type === "sep") {
			const sep = document.createElement("div");
			sep.className = "item-context-sep";
			menu.appendChild(sep);
			continue;
		}
		const button = document.createElement("button");
		button.type = "button";
		button.className = "item-context-item";
		button.role = "menuitem";
		const label = document.createElement("span");
		label.textContent = entry.label;
		button.appendChild(label);
		if (entry.hint) {
			const hint = document.createElement("span");
			hint.className = "item-context-hint";
			hint.textContent = entry.hint;
			button.appendChild(hint);
		}
		button.onclick = (click) => {
			click.stopPropagation();
			closeItemContextMenu();
			onPick(entry.id);
		};
		menu.appendChild(button);
	}
	document.body.appendChild(menu);
	const pad = 8;
	const left = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - pad);
	const top = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - pad);
	menu.style.left = `${Math.max(pad, left)}px`;
	menu.style.top = `${Math.max(pad, top)}px`;
	openMenu = menu;
	const dismiss = (next: Event): void => {
		if (next instanceof MouseEvent && menu.contains(next.target as Node)) return;
		closeItemContextMenu();
		window.removeEventListener("pointerdown", dismiss, true);
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("blur", dismiss);
	};
	const onKey = (next: KeyboardEvent): void => {
		// Swallow every key while the menu is open, not just Escape — this
		// menu doesn't offer its own arrow/Enter navigation, so without this
		// those keys fell straight through to the list underneath (moving
		// its selection, or triggering its own Enter-on-highlighted-item
		// behavior) while the menu stayed visibly open on top. Capture
		// phase, same as the pointerdown dismiss listener just below:
		// nothing in this menu takes focus, so the key event's real target
		// stays whatever had focus before the right-click — a bubble-phase
		// listener here would run *after* the list's own document-level
		// handler, not before it.
		next.stopPropagation();
		if (next.key === "Escape") dismiss(next);
	};
	queueMicrotask(() => {
		window.addEventListener("pointerdown", dismiss, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", dismiss);
	});
}

let openPalette: HTMLElement | null = null;

export function closeCommandPalette(): void {
	openPalette?.remove();
	openPalette = null;
}

/**
 * ⌘P: the same actions `openItemContextMenu` offers, in a centered, typeahead-
 * filterable list — a keyboard-first alternative to right-clicking a row.
 */
export function openCommandPalette(entries: ContextEntry[], onPick: (id: string) => void): void {
	closeItemContextMenu();
	closeCommandPalette();

	const actions = entries.filter(
		(entry): entry is Extract<ContextEntry, { type: "item" }> => entry.type === "item",
	);
	let shown = actions;
	let activeIndex = 0;

	const overlay = document.createElement("div");
	overlay.className = "command-palette-overlay";
	const palette = document.createElement("div");
	palette.className = "command-palette";
	palette.role = "menu";
	overlay.appendChild(palette);

	const search = document.createElement("input");
	search.type = "text";
	search.className = "command-palette-input";
	search.placeholder = "Search actions…";
	palette.appendChild(search);

	const listEl = document.createElement("div");
	listEl.className = "command-palette-list";
	palette.appendChild(listEl);

	const pick = (entry: Extract<ContextEntry, { type: "item" }>): void => {
		close();
		onPick(entry.id);
	};

	const renderList = (): void => {
		listEl.innerHTML = "";
		if (shown.length === 0) {
			const empty = document.createElement("div");
			empty.className = "command-palette-empty";
			empty.textContent = "No matching actions.";
			listEl.appendChild(empty);
			return;
		}
		shown.forEach((entry, index) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "command-palette-item";
			button.classList.toggle("active", index === activeIndex);
			button.role = "menuitem";
			const label = document.createElement("span");
			label.textContent = entry.label;
			button.appendChild(label);
			if (entry.hint) {
				const hint = document.createElement("span");
				hint.className = "item-context-hint";
				hint.textContent = entry.hint;
				button.appendChild(hint);
			}
			button.onclick = (click) => {
				click.stopPropagation();
				pick(entry);
			};
			listEl.appendChild(button);
		});
	};

	const filter = (): void => {
		const query = search.value.trim();
		shown = query
			? actions
					.map((entry) => ({ entry, match: fuzzyMatch(query, entry.label) }))
					.filter(
						(
							r,
						): r is {
							entry: (typeof actions)[number];
							match: NonNullable<ReturnType<typeof fuzzyMatch>>;
						} => r.match !== null,
					)
					.sort((a, b) => b.match.score - a.match.score)
					.map((r) => r.entry)
			: actions;
		activeIndex = 0;
		renderList();
	};

	search.oninput = filter;
	search.onkeydown = (e) => {
		// The search input holds focus while the palette is open, so it's
		// the actual event target — stopping it here (unlike the plain
		// context menu's dismiss listener above) is enough on its own, no
		// capture phase needed. Without this, preventDefault() alone left
		// every one of these keys *also* reaching the list underneath:
		// arrows moved its selection, and Enter acted on its highlighted
		// item (typically hiding the panel) while the palette stayed open.
		e.stopPropagation();
		if (e.key === "ArrowDown") {
			e.preventDefault();
			activeIndex = Math.min(activeIndex + 1, shown.length - 1);
			renderList();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = Math.max(activeIndex - 1, 0);
			renderList();
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = shown[activeIndex];
			if (entry) pick(entry);
		} else if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	};

	filter();
	document.body.appendChild(overlay);
	openPalette = overlay;
	search.focus();

	function close(): void {
		closeCommandPalette();
		window.removeEventListener("pointerdown", dismiss, true);
		window.removeEventListener("blur", close);
	}
	const dismiss = (next: Event): void => {
		if (next instanceof MouseEvent && palette.contains(next.target as Node)) return;
		close();
	};
	queueMicrotask(() => {
		window.addEventListener("pointerdown", dismiss, true);
		window.addEventListener("blur", close);
	});
}

let openTagPrompt: HTMLElement | null = null;

export function closeTagPrompt(): void {
	openTagPrompt?.remove();
	openTagPrompt = null;
}

/**
 * A single-line, in-app text prompt for "Tag selected...". `window.prompt`
 * doesn't reliably work in this webview (native dialogs aren't fully
 * supported here — see the "Tag selected" bug report) and even where it
 * does render, its input isn't ours to configure, so its spellcheck/
 * autocorrect can't be turned off the way every other input in this app
 * has it turned off.
 */
export function promptForTag(label: string, onSubmit: (value: string) => void): void {
	closeItemContextMenu();
	closeCommandPalette();
	closeTagPrompt();

	const overlay = document.createElement("div");
	overlay.className = "tag-prompt-overlay";
	const box = document.createElement("div");
	box.className = "tag-prompt";
	overlay.appendChild(box);

	const labelEl = document.createElement("div");
	labelEl.className = "tag-prompt-label";
	labelEl.textContent = label;
	box.appendChild(labelEl);

	const input = document.createElement("input");
	input.type = "text";
	input.className = "tag-prompt-input";
	input.placeholder = "tag-name";
	input.spellcheck = false;
	input.setAttribute("autocorrect", "off");
	input.setAttribute("autocapitalize", "off");
	box.appendChild(input);

	function close(): void {
		closeTagPrompt();
		window.removeEventListener("pointerdown", dismiss, true);
	}
	const dismiss = (next: Event): void => {
		if (next instanceof MouseEvent && box.contains(next.target as Node)) return;
		close();
	};
	input.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			const value = input.value.trim();
			close();
			if (value) onSubmit(value);
		} else if (e.key === "Escape") {
			close();
		}
	};

	document.body.appendChild(overlay);
	openTagPrompt = overlay;
	// WebKit only honors spellcheck/autocorrect="off" if they're already on
	// the node when it establishes the input's text-replacement session;
	// focusing in the same tick as the attributes are set (and the node is
	// inserted) races that and loses, showing the native suggestion bubble.
	requestAnimationFrame(() => input.focus());
	queueMicrotask(() => window.addEventListener("pointerdown", dismiss, true));
}
