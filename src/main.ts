import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { filterItems, findDuplicate, parseUiCommand, resolveCapture } from "./capture-logic";
import { Store, type Action, type Item, type Settings, type Template } from "./store";
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
let selected = -1;
let settings: Settings | null = null;

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
	const query = input.value;
	if (!query || query.startsWith("/")) return items;
	return filterItems(items, query);
}

function updateDuplicateHint(): void {
	const query = input.value;
	const duplicate = !query.startsWith("/") && findDuplicate(items, query);
	duplicateHint.hidden = !duplicate;
}

function renderList(): void {
	filtered = computeFiltered();
	if (selected >= filtered.length) selected = filtered.length - 1;
	list.innerHTML = "";
	filtered.forEach((item, index) => {
		list.appendChild(buildRow(item, index));
	});
	updateDuplicateHint();
}

function buildRow(item: Item, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "item-row";
	row.dataset.done = String(item.done);
	row.classList.toggle("selected", index === selected);
	row.onclick = () => {
		selected = index;
		renderList();
	};

	row.appendChild(buildIcon(item));

	const text = document.createElement("div");
	text.className = "item-text";
	if (editingId === item.id) {
		row.appendChild(buildEditInput(item));
	} else {
		text.textContent = item.text;
		text.onclick = (e) => {
			e.stopPropagation();
			void actOnItem(item);
		};
		row.appendChild(text);
	}

	const actions = document.createElement("div");
	actions.className = "item-actions";

	const bookmark = document.createElement("button");
	bookmark.className = "item-action item-bookmark";
	bookmark.title = "Bookmark";
	bookmark.textContent = item.bookmarked ? "★" : "☆";
	bookmark.onclick = (e) => {
		e.stopPropagation();
		void Store.toggleBookmarked(item.id).then(refresh);
	};
	actions.appendChild(bookmark);

	const edit = document.createElement("button");
	edit.className = "item-action item-edit";
	edit.title = "Edit";
	edit.textContent = "✎";
	edit.onclick = (e) => {
		e.stopPropagation();
		startEditing(item.id);
	};
	actions.appendChild(edit);

	const del = document.createElement("button");
	del.className = "item-action item-delete";
	del.title = "Delete";
	del.textContent = "🗑";
	del.onclick = (e) => {
		e.stopPropagation();
		void Store.deleteItem(item.id).then(refresh);
	};
	actions.appendChild(del);

	row.appendChild(actions);
	return row;
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
	icon.textContent = item.kind === "link" ? "↗" : "●";
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

/** Enter on a selected row: copy note/todo text, open a link. */
async function actOnItem(item: Item): Promise<void> {
	if (item.kind === "link") {
		await open(item.text);
		return;
	}
	await navigator.clipboard.writeText(item.text);
}

async function refresh(): Promise<void> {
	items = await Store.listItems();
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

input.addEventListener("keydown", async (e) => {
	const modKey = e.metaKey || e.ctrlKey;

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
	if (modKey && e.key.toLowerCase() === "e" && selected >= 0 && filtered[selected]) {
		e.preventDefault();
		startEditing(filtered[selected]!.id);
		return;
	}

	if (e.key !== "Enter") return;
	const raw = input.value.trim();
	if (!raw) return;

	if (modKey) {
		await saveNew(raw);
		return;
	}
	if (raw.startsWith("/")) {
		await handleSlashEnter(raw);
		return;
	}
	if (selected >= 0 && filtered[selected]) {
		await actOnItem(filtered[selected]!);
		return;
	}
	await saveNew(raw);
});

input.addEventListener("input", () => {
	selected = computeFiltered().length > 0 ? 0 : -1;
	renderList();
});

input.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		e.preventDefault();
		void getCurrentWindow().hide();
	}
});

// The Rust side emits "refresh" after any mutation made outside this window
// (capture-selection hotkey, tray actions, CLI capture) so the list stays
// in sync without polling.
listen("refresh", () => void refresh());

window.addEventListener("focus", () => input.focus());

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

function buildNotificationRows(current: Settings): HTMLElement[] {
	const notifyRow = document.createElement("div");
	notifyRow.className = "settings-row";
	const notifyLabel = document.createElement("label");
	notifyLabel.textContent = "Notify when something is saved";
	notifyRow.appendChild(notifyLabel);
	const notifyCheckbox = document.createElement("input");
	notifyCheckbox.type = "checkbox";
	notifyCheckbox.checked = current.notify_on_save;
	notifyCheckbox.onchange = async () => {
		const next = { ...current, notify_on_save: notifyCheckbox.checked };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	notifyRow.appendChild(notifyCheckbox);

	const soundRow = document.createElement("div");
	soundRow.className = "settings-row";
	const soundLabel = document.createElement("label");
	soundLabel.textContent = "Play a sound";
	soundRow.appendChild(soundLabel);
	const soundCheckbox = document.createElement("input");
	soundCheckbox.type = "checkbox";
	soundCheckbox.checked = current.notify_sound;
	soundCheckbox.disabled = !current.notify_on_save;
	soundCheckbox.onchange = async () => {
		const next = { ...current, notify_sound: soundCheckbox.checked };
		settings = next;
		await Store.setSettings(next);
		await openSettings();
	};
	soundRow.appendChild(soundCheckbox);

	return [notifyRow, soundRow];
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
	return accel.replaceAll("CmdOrCtrl", "⌘").replaceAll("Shift", "⇧").replaceAll("Alt", "⌥").replaceAll("+", " ");
}

function buildShortcutRow(label: string, key: "fallback_toggle" | "fallback_capture", current: Settings): HTMLElement {
	const row = document.createElement("div");
	row.className = "settings-row";

	const name = document.createElement("label");
	name.textContent = label;
	row.appendChild(name);

	const button = document.createElement("button");
	button.className = "shortcut-recorder";
	button.textContent = formatAccelerator(current[key]);
	button.onclick = () => {
		button.textContent = "Press a shortcut…";
		const onKeydown = async (e: KeyboardEvent): Promise<void> => {
			e.preventDefault();
			const accel = eventToAccelerator(e);
			window.removeEventListener("keydown", onKeydown, true);
			if (!accel) {
				button.textContent = formatAccelerator(current[key]);
				return;
			}
			const next = { ...current, [key]: accel };
			try {
				await Store.setSettings(next);
				settings = next;
				button.textContent = formatAccelerator(accel);
			} catch {
				button.textContent = formatAccelerator(current[key]);
			}
		};
		window.addEventListener("keydown", onKeydown, true);
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

function heading(text: string): HTMLElement {
	const h = document.createElement("h3");
	h.textContent = text;
	return h;
}

async function openSettings(): Promise<void> {
	const [current, templates] = await Promise.all([loadSettings(), Store.listTemplates()]);
	settingsView.innerHTML = "";

	settingsView.appendChild(heading("Appearance"));
	settingsView.appendChild(buildThemeRow(current));

	settingsView.appendChild(heading("Double-shift bindings"));
	settingsView.appendChild(buildBindingRow("Left Shift", "left", current));
	settingsView.appendChild(buildBindingRow("Right Shift", "right", current));

	settingsView.appendChild(heading("Fallback shortcuts"));
	settingsView.appendChild(buildShortcutRow("Toggle panel", "fallback_toggle", current));
	settingsView.appendChild(buildShortcutRow("Capture selection", "fallback_capture", current));

	settingsView.appendChild(heading("Notifications"));
	for (const row of buildNotificationRows(current)) settingsView.appendChild(row);

	settingsView.appendChild(heading("Snippet templates"));
	for (const template of templates) {
		settingsView.appendChild(buildTemplateRow(template));
	}
	settingsView.appendChild(buildAddTemplateForm());

	settingsView.appendChild(heading("Export"));
	settingsView.appendChild(buildExportRow());

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
