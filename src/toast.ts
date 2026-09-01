import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Store } from "./store";
import { applyCustomPalette, clearCustomPalette, isThemeId, normalizeTheme } from "./themes";
import { normalizeThemeColors } from "./capture-logic";

let appliedTheme = "";

function applyBuiltinTheme(themeId: string): void {
	if (appliedTheme === themeId) return;
	appliedTheme = themeId;
	clearCustomPalette(document.documentElement);
	document.documentElement.dataset.theme = normalizeTheme(themeId);
}

async function hydrateCustomTheme(themeId: string): Promise<void> {
	if (isThemeId(themeId)) return;
	try {
		const customThemes = await Store.listCustomThemes();
		const custom = customThemes.find((t) => t.id === themeId);
		if (!custom || appliedTheme === `custom:${themeId}`) return;
		appliedTheme = `custom:${themeId}`;
		applyCustomPalette(document.documentElement, normalizeThemeColors(custom.colors), custom.mode);
	} catch {
		/* toast window may not have settings IPC — payload theme is enough */
	}
}

function playToast(title: string, body: string, fontScale: number, theme: string): void {
	applyBuiltinTheme(theme);
	titleEl.textContent = title;
	bodyEl.textContent = body;
	toast.classList.toggle("capture-toast-icon-only", !title && !body);
	toast.style.setProperty("--toast-font-scale", String(fontScale / 100));
	toast.classList.remove("capture-toast-play");
	void toast.offsetWidth;
	toast.classList.add("capture-toast-play");
	void getCurrentWindow().show();
	void hydrateCustomTheme(theme);
}

const root = document.getElementById("toast-app")!;
root.innerHTML = `
	<div class="capture-toast">
		<div class="capture-toast-icon">
			<svg class="capture-toast-check" viewBox="0 0 52 52">
				<circle class="capture-toast-check-circle" cx="26" cy="26" r="23" fill="none" />
				<path class="capture-toast-check-mark" fill="none" d="M14 27l7 7 16-16" />
			</svg>
			<div class="capture-toast-sparkles"><span></span><span></span><span></span><span></span></div>
		</div>
		<div class="capture-toast-text">
			<div class="capture-toast-title"></div>
			<div class="capture-toast-body"></div>
		</div>
	</div>
`;
const toast = root.querySelector<HTMLElement>(".capture-toast")!;
const titleEl = root.querySelector<HTMLElement>(".capture-toast-title")!;
const bodyEl = root.querySelector<HTMLElement>(".capture-toast-body")!;

void listen<{ title: string; body: string; font_scale: number; theme: string }>("capture-toast", (event) => {
	playToast(event.payload.title, event.payload.body, event.payload.font_scale, event.payload.theme);
}).then(() => Store.toastReady());

// Only reachable while Settings -> Notifications -> "Drag to place" is
// active (toast.rs's `start_arrange` is the only state that disables
// `ignore_cursor_events`) — a transient auto-hiding toast is click-through,
// so it never receives these. `blur` covers clicking away without ever
// dragging, so an abandoned arrange session doesn't float on screen forever.
toast.addEventListener("mousedown", () => void getCurrentWindow().startDragging());
window.addEventListener("mouseup", () => void Store.finishToastArrange());
window.addEventListener("blur", () => void Store.finishToastArrange());
