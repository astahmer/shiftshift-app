import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { resolveCapture } from "./capture-logic";
import { Store, type Action, type Bindings, type Item, type Template } from "./store";

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

const list = document.createElement("div");
list.className = "item-list";
app.appendChild(list);

const settingsView = document.createElement("div");
settingsView.className = "settings-view";
settingsView.hidden = true;
app.appendChild(settingsView);

let items: Item[] = [];

function render(): void {
	list.innerHTML = "";
	for (const item of items) {
		const row = document.createElement("div");
		row.className = "item-row";
		row.dataset.kind = item.kind;
		row.dataset.done = String(item.done);

		const check = document.createElement("div");
		check.className = "item-check";
		check.dataset.done = String(item.done);
		check.onclick = () => Store.toggleDone(item.id).then(refresh);
		row.appendChild(check);

		const text = document.createElement("div");
		text.className = "item-text";
		text.textContent = item.text;
		if (item.kind === "link") {
			text.onclick = () => void open(item.text);
		}
		row.appendChild(text);

		const pin = document.createElement("div");
		pin.className = "item-pin";
		pin.textContent = item.pinned ? "📌" : "";
		pin.onclick = () => Store.togglePinned(item.id).then(refresh);
		row.appendChild(pin);

		list.appendChild(row);
	}
}

async function refresh(): Promise<void> {
	items = await Store.listItems();
	render();
}

input.addEventListener("keydown", async (e) => {
	if (e.key !== "Enter") return;
	const raw = input.value.trim();
	if (!raw) return;
	const templates = raw.startsWith("/") ? await Store.listTemplates() : [];
	const { text, kind } = resolveCapture(raw, templates);
	await Store.addItem(text, kind);
	input.value = "";
	await refresh();
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

function buildBindingRow(label: string, key: keyof Bindings, bindings: Bindings): HTMLElement {
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
		option.selected = bindings[key] === action;
		select.appendChild(option);
	}
	select.onchange = async () => {
		await Store.setBindings({ ...bindings, [key]: select.value as Action });
		await openSettings();
	};
	row.appendChild(select);
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

async function openSettings(): Promise<void> {
	const [bindings, templates] = await Promise.all([Store.getBindings(), Store.listTemplates()]);
	settingsView.innerHTML = "";

	const bindingsHeading = document.createElement("h3");
	bindingsHeading.textContent = "Double-shift bindings";
	settingsView.appendChild(bindingsHeading);
	settingsView.appendChild(buildBindingRow("Left Shift", "left", bindings));
	settingsView.appendChild(buildBindingRow("Right Shift", "right", bindings));

	const templatesHeading = document.createElement("h3");
	templatesHeading.textContent = "Snippet templates";
	settingsView.appendChild(templatesHeading);
	for (const template of templates) {
		settingsView.appendChild(buildTemplateRow(template));
	}
	settingsView.appendChild(buildAddTemplateForm());

	const exportHeading = document.createElement("h3");
	exportHeading.textContent = "Export";
	settingsView.appendChild(exportHeading);
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

void refresh();
