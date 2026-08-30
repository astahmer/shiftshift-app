import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { filterItems, findDuplicate, matchSlashSuggestions, parseUiCommand, resolveCapture, type SlashSuggestion } from "./capture-logic";
import { Store, type Action, type CaptureMode, type Item, type MoveDirection, type S3Settings, type Settings, type Template } from "./store";
import { findThemeByName, normalizeTheme, siblingTheme, THEMES, type ThemeId } from "./themes";

const app = document.getElementById("app")!;

const captureRow = document.createElement("div");
captureRow.className = "capture-row";
app.appendChild(captureRow);

const input = document.createElement("input");
input.className = "capture-input";
input.placeholder = "Capture anything...";
captureRow.appendChild(input);

const settingsBtn = document.createElement("button");
settingsBtn.className = "settings-btn";
settingsBtn.textContent = "⚙";
settingsBtn.title = "Settings";
captureRow.appendChild(settingsBtn);

const duplicateHint = document.createElement("div");
duplicateHint.className = "duplicate-hint";
duplicateHint.hidden = true;
duplicateHint.textContent = "Already saved — Enter adds it again";
app.appendChild(duplicateHint);

const list = document.createElement("div");
list.className = "item-list";
app.appendChild(list);

const settingsView = document.createElement("div");
settingsView.className = "settings-view";
settingsView.hidden = true;
app.appendChild(settingsView);

let items: Item[] = [];
let filtered: Item[] = [];
let templatesCache: Template[] = [];
let selected = -1;
let settings: Settings | null = null;
/** Built up with Shift+Enter; plain Enter copies all of these joined as a numbered list and closes. */
const multiSelected = new Set<string>();

function applyTheme(themeId: ThemeId): void {
	document.documentElement.dataset.theme = themeId;
}

async function loadSettings(): Promise<Settings> {
	if (!settings) {
		settings = await Store.getSettings();
		applyTheme(normalizeTheme(settings.theme));
	}
	return settings;
}

function computeFiltered(): Item[] {
	return filterItems(items, input.value);
}

function updateHint(): void {
	if (multiSelected.size > 0) {
		duplicateHint.hidden = false;
		duplicateHint.textContent = `${multiSelected.size} selected — Enter copies them as a numbered list`;
		return;
	}
	duplicateHint.textContent = "Already saved — Enter adds it again";
	const query = input.value;
	const duplicate = !query.startsWith("/") && findDuplicate(items, query);
	duplicateHint.hidden = !duplicate;
}

function renderList(): void {
	const raw = input.value;
	if (raw.startsWith("/")) {
		// Stale from before slash-mode was entered — item-row keyboard shortcuts
		// (bookmark/delete/etc, all guarded on `filtered[selected]`) must not
		// fire against it while browsing command suggestions instead.
		filtered = [];
		renderSlashSuggestions(raw);
		return;
	}
	filtered = computeFiltered();
	if (selected >= filtered.length) selected = filtered.length - 1;
	list.innerHTML = "";
	filtered.forEach((item, index) => {
		list.appendChild(buildRow(item, index));
	});
	updateHint();
}

function renderSlashSuggestions(raw: string): void {
	const suggestions = matchSlashSuggestions(raw, templatesCache);
	if (selected >= suggestions.length) selected = suggestions.length - 1;
	list.innerHTML = "";
	suggestions.forEach((suggestion, index) => list.appendChild(buildSuggestionRow(suggestion, index)));
	duplicateHint.hidden = true;
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

function buildRow(item: Item, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row";
	row.dataset.done = String(item.done);
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
	} else {
		const text = document.createElement("div");
		text.className = "item-text";
		text.textContent = item.text;
		text.onclick = (e) => {
			e.stopPropagation();
			void actOnItem(item);
		};
		row.appendChild(text);
	}

	const actions = document.createElement("div");
	actions.className = "item-actions";

	actions.appendChild(
		buildActionButton("item-bookmark", "Bookmark", item.bookmarked ? "★" : "☆", "⌘B", (e) => {
			e.stopPropagation();
			void Store.toggleBookmarked(item.id).then(refresh);
		}),
	);

	if (item.kind !== "todo" && item.kind !== "image") {
		actions.appendChild(
			buildActionButton("item-todo", "Convert to todo", "☑", "⌘T", (e) => {
				e.stopPropagation();
				void Store.setKind(item.id, "todo").then(refresh);
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
		buildActionButton("item-delete", "Delete", "🗑", "⌫", (e) => {
			e.stopPropagation();
			void Store.deleteItem(item.id).then(refresh);
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
		check.onclick = (e) => {
			e.stopPropagation();
			void Store.toggleDone(item.id).then(refresh);
		};
		return check;
	}
	const icon = document.createElement("div");
	icon.className = `item-icon item-icon-${item.kind}`;
	icon.textContent = item.kind === "link" ? "↗" : item.kind === "image" ? "▧" : "●";
	return icon;
}

let editingId: string | null = null;

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

async function refresh(): Promise<void> {
	[items, templatesCache] = await Promise.all([Store.listItems(), Store.listTemplates()]);
	renderList();
}

async function saveNew(raw: string): Promise<void> {
	const templates = raw.startsWith("/") ? await Store.listTemplates() : [];
	const { text, kind } = resolveCapture(raw, templates);
	await Store.addItem(text, kind);
	input.value = "";
	selected = -1;
	await refresh();
}

async function handleSlashEnter(raw: string): Promise<void> {
	const uiCommand = parseUiCommand(raw);
	if (uiCommand) {
		if (uiCommand.type === "open-settings") await openSettings();
		if (uiCommand.type === "set-theme-mode") await setTheme(siblingTheme(normalizeTheme(settings?.theme), uiCommand.mode));
		if (uiCommand.type === "set-theme") {
			const theme = findThemeByName(uiCommand.query);
			if (theme) await setTheme(theme.id);
		}
		input.value = "";
		return;
	}
	await saveNew(raw);
}

async function setTheme(themeId: ThemeId): Promise<void> {
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
		if (multiSelected.size > 0) {
			multiSelected.clear();
			renderList();
			return;
		}
		if (!settingsView.hidden) {
			closeSettings();
			return;
		}
		await getCurrentWindow().hide();
		return;
	}

	// Settings' own form controls (selects, the shortcut recorder) need native
	// keyboard behavior; the item-list shortcuts below don't apply there.
	if (!settingsView.hidden) return;
	// The inline edit input already handles its own keys and stops
	// propagation, but guard anyway in case focus is elsewhere mid-edit.
	if (editingId !== null) return;

	const modKey = e.metaKey || e.ctrlKey;

	if (e.key === "Tab" && input.value.startsWith("/")) {
		e.preventDefault();
		const suggestions = matchSlashSuggestions(input.value, templatesCache);
		const pick = selected >= 0 ? suggestions[selected] : suggestions[0];
		if (pick) {
			input.value = `/${pick.name} `;
			selected = -1;
			renderList();
		}
		return;
	}
	// Only in the unfiltered (full, rank-ordered) view — a filtered view's
	// visual neighbors aren't necessarily rank-adjacent, so "move up" could
	// jump somewhere that doesn't look like "up" at all.
	if (e.altKey && input.value === "" && (e.key === "ArrowUp" || e.key === "ArrowDown") && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const direction: MoveDirection = e.key === "ArrowUp" ? "up" : "down";
		await Store.moveItem(filtered[selected]!.id, direction);
		await refresh();
		return;
	}
	if (e.key === "ArrowDown") {
		e.preventDefault();
		if (filtered.length > 0) selected = Math.min(selected + 1, filtered.length - 1);
		renderList();
		return;
	}
	if (e.key === "ArrowUp") {
		e.preventDefault();
		if (filtered.length > 0) selected = Math.max(selected - 1, 0);
		renderList();
		return;
	}
	if (e.key === " " && input.value === "" && selected >= 0 && filtered[selected]?.kind === "todo") {
		e.preventDefault();
		await Store.toggleDone(filtered[selected]!.id);
		await refresh();
		return;
	}
	if ((e.key === "Backspace" || e.key === "Delete") && input.value === "" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		await Store.deleteItem(filtered[selected]!.id);
		await refresh();
		return;
	}
	if (modKey && e.key.toLowerCase() === "b" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		await Store.toggleBookmarked(filtered[selected]!.id);
		await refresh();
		return;
	}
	if (modKey && e.key.toLowerCase() === "e" && selected >= 0 && filtered[selected] && filtered[selected]!.kind !== "image") {
		e.preventDefault();
		startEditing(filtered[selected]!.id);
		return;
	}
	if (
		modKey &&
		e.key.toLowerCase() === "t" &&
		selected >= 0 &&
		filtered[selected] &&
		filtered[selected]!.kind !== "todo" &&
		filtered[selected]!.kind !== "image"
	) {
		e.preventDefault();
		await Store.setKind(filtered[selected]!.id, "todo");
		await refresh();
		return;
	}

	if (e.key !== "Enter") return;

	if (e.shiftKey && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		const id = filtered[selected]!.id;
		if (multiSelected.has(id)) multiSelected.delete(id);
		else multiSelected.add(id);
		if (filtered.length > 0) selected = Math.min(selected + 1, filtered.length - 1);
		renderList();
		return;
	}

	const raw = input.value.trim();

	if (!raw && multiSelected.size > 0) {
		await copyMultiSelectionAndClose();
		return;
	}
	if (!raw) return;

	if (modKey) {
		await saveNew(raw);
		return;
	}
	if (raw.startsWith("/")) {
		await handleSlashEnter(raw);
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
	await saveNew(raw);
});

input.addEventListener("input", () => {
	const raw = input.value;
	const count = raw.startsWith("/") ? matchSlashSuggestions(raw, templatesCache).length : computeFiltered().length;
	selected = count > 0 ? 0 : -1;
	renderList();
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
		await openSettings();
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
	for (const theme of THEMES) {
		const option = document.createElement("option");
		option.value = theme.id;
		option.textContent = theme.label;
		option.selected = current.theme === theme.id;
		select.appendChild(option);
	}
	select.onchange = () => void setTheme(select.value as ThemeId);
	row.appendChild(select);
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
		await openSettings();
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
			await Store.captureClipboardImage();
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
	for (const value of ["local", "s3"] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value === "local" ? "Local (this device only)" : "S3-compatible bucket";
		option.selected = current.backend === value;
		backendSelect.appendChild(option);
	}
	backendSelect.onchange = async () => {
		const next = { ...current, backend: backendSelect.value as Settings["backend"] };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
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
	return rows;
}

function heading(text: string): HTMLElement {
	const h = document.createElement("h3");
	h.textContent = text;
	return h;
}

async function openSettings(): Promise<void> {
	const [current, templates, historySection] = await Promise.all([loadSettings(), Store.listTemplates(), buildHistorySection()]);
	settingsView.innerHTML = "";

	settingsView.appendChild(heading("Appearance"));
	settingsView.appendChild(buildThemeRow(current));

	settingsView.appendChild(heading("Capture behavior"));
	settingsView.appendChild(buildCaptureModeRow(current));
	for (const row of buildBehaviorRows(current)) settingsView.appendChild(row);

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
	for (const row of buildSyncRows(current)) settingsView.appendChild(row);

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
