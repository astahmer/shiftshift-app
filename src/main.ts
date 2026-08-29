import { listen } from "@tauri-apps/api/event";
import { Store, type Item } from "./store";

const app = document.getElementById("app")!;

const input = document.createElement("input");
input.className = "capture-input";
input.placeholder = "Capture anything...";
app.appendChild(input);

const list = document.createElement("div");
list.className = "item-list";
app.appendChild(list);

let items: Item[] = [];

function detectKind(text: string): Item["kind"] {
	if (text.startsWith("/todo ")) return "todo";
	if (/^https?:\/\/\S+$/.test(text.trim())) return "link";
	return "note";
}

function stripPrefix(text: string): string {
	return text.startsWith("/todo ") ? text.slice("/todo ".length) : text;
}

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
	await Store.addItem(stripPrefix(raw), detectKind(raw));
	input.value = "";
	await refresh();
});

// The Rust side emits "refresh" after any mutation made outside this window
// (capture-selection hotkey, tray actions, CLI capture) so the list stays
// in sync without polling.
listen("refresh", () => void refresh());

window.addEventListener("focus", () => input.focus());

void refresh();
