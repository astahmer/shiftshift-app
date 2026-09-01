/**
 * Theme registry (data only, no DOM) — ported from shiftshift's `themes.ts`,
 * same theme set and light/dark "family" pairing so `/light` and `/dark`
 * can jump to the sibling of whatever theme is active. Each id maps to a
 * `[data-theme="<id>"]` CSS variable block in `style.css`.
 */

import type { ThemeColors } from "./store";

export type ThemeMode = "dark" | "light";

export type ThemeId =
	| "tokyo-night"
	| "tokyo-light"
	| "vscode-dark"
	| "vscode-light"
	| "github-dark"
	| "github-light"
	| "catppuccin-mocha"
	| "catppuccin-latte"
	| "dracula"
	| "nord"
	| "one-dark"
	| "gruvbox-dark"
	| "rose-pine"
	| "rose-pine-dawn"
	| "solarized-dark"
	| "solarized-light"
	| "glass"
	| "neobrutalism"
	| "neobrutalism-dark"
	| "paper"
	| "win95"
	| "win95-dark"
	| "win-vista"
	| "win-vista-dark"
	| "win7"
	| "win7-dark"
	| "mac"
	| "mac-dark"
	| "terminal"
	| "terminal-light"
	| "codex"
	| "codex-light"
	| "raycast"
	| "discord"
	| "kanagawa"
	| "kanagawa-lotus"
	| "everforest"
	| "everforest-light"
	| "oled";

export interface ThemeDef {
	id: ThemeId;
	label: string;
	mode: ThemeMode;
	/** Themes in the same family are each other's light/dark siblings. */
	family: string;
}

export const THEMES: ThemeDef[] = [
	{ id: "tokyo-night", label: "Tokyo Night", mode: "dark", family: "tokyo" },
	{ id: "tokyo-light", label: "Tokyo Night Day", mode: "light", family: "tokyo" },
	{ id: "vscode-dark", label: "VS Code Dark+", mode: "dark", family: "vscode" },
	{ id: "vscode-light", label: "VS Code Light+", mode: "light", family: "vscode" },
	{ id: "github-dark", label: "GitHub Dark", mode: "dark", family: "github" },
	{ id: "github-light", label: "GitHub Light", mode: "light", family: "github" },
	{ id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark", family: "catppuccin" },
	{ id: "catppuccin-latte", label: "Catppuccin Latte", mode: "light", family: "catppuccin" },
	{ id: "dracula", label: "Dracula", mode: "dark", family: "dracula" },
	{ id: "nord", label: "Nord", mode: "dark", family: "nord" },
	{ id: "one-dark", label: "One Dark Pro", mode: "dark", family: "one" },
	{ id: "gruvbox-dark", label: "Gruvbox Dark", mode: "dark", family: "gruvbox" },
	{ id: "rose-pine", label: "Rosé Pine", mode: "dark", family: "rose-pine" },
	{ id: "rose-pine-dawn", label: "Rosé Pine Dawn", mode: "light", family: "rose-pine" },
	{ id: "solarized-dark", label: "Solarized Dark", mode: "dark", family: "solarized" },
	{ id: "solarized-light", label: "Solarized Light", mode: "light", family: "solarized" },
	{ id: "glass", label: "Glass", mode: "dark", family: "glass" },
	{ id: "neobrutalism", label: "Neobrutalism", mode: "light", family: "neobrutalism" },
	{ id: "neobrutalism-dark", label: "Neobrutalism Dark", mode: "dark", family: "neobrutalism" },
	{ id: "paper", label: "Paper", mode: "light", family: "paper" },
	{ id: "win95", label: "Windows 95", mode: "light", family: "win95" },
	{ id: "win95-dark", label: "Windows 95 Dark", mode: "dark", family: "win95" },
	{ id: "win-vista", label: "Windows Vista", mode: "light", family: "vista" },
	{ id: "win-vista-dark", label: "Windows Vista Dark", mode: "dark", family: "vista" },
	{ id: "win7", label: "Windows 7", mode: "light", family: "win7" },
	{ id: "win7-dark", label: "Windows 7 Dark", mode: "dark", family: "win7" },
	{ id: "mac", label: "macOS", mode: "light", family: "mac" },
	{ id: "mac-dark", label: "macOS Dark", mode: "dark", family: "mac" },
	{ id: "terminal", label: "Terminal", mode: "dark", family: "terminal" },
	{ id: "terminal-light", label: "Terminal Light", mode: "light", family: "terminal" },
	{ id: "codex", label: "Codex", mode: "dark", family: "codex" },
	{ id: "codex-light", label: "Codex Light", mode: "light", family: "codex" },
	{ id: "raycast", label: "Raycast", mode: "dark", family: "raycast" },
	{ id: "discord", label: "Discord", mode: "dark", family: "discord" },
	{ id: "kanagawa", label: "Kanagawa", mode: "dark", family: "kanagawa" },
	{ id: "kanagawa-lotus", label: "Kanagawa Lotus", mode: "light", family: "kanagawa" },
	{ id: "everforest", label: "Everforest", mode: "dark", family: "everforest" },
	{ id: "everforest-light", label: "Everforest Light", mode: "light", family: "everforest" },
	{ id: "oled", label: "OLED", mode: "dark", family: "oled" },
];

export const DEFAULT_THEME: ThemeId = "tokyo-night";

export function isThemeId(value: string): value is ThemeId {
	return THEMES.some((t) => t.id === value);
}

export function normalizeTheme(value: string | undefined | null): ThemeId {
	if (value && isThemeId(value)) return value;
	return DEFAULT_THEME;
}

export function getTheme(id: ThemeId): ThemeDef {
	return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** Same family, other mode; falls back to the first theme of `mode`. */
export function siblingTheme(id: ThemeId, mode: ThemeMode): ThemeId {
	const current = getTheme(id);
	return THEMES.find((t) => t.family === current.family && t.mode === mode)?.id ?? THEMES.find((t) => t.mode === mode)!.id;
}

/** Finds a theme by label or id, case-insensitively — used by `/theme <name>`. */
const CUSTOM_STYLE_PROPS = [
	"--bg",
	"--fg",
	"--muted",
	"--row-bg",
	"--accent",
	"--accent-fg",
	"--border",
	"--bg-alpha",
	"--row-alpha",
	"--input-bg",
	"--input-fg",
	"--input-border",
	"--button-bg",
	"--button-fg",
	"--selected-bg",
	"--hover-bg",
	"--danger",
	"--meta",
	"--radius",
	"--window-radius",
	"--radius-sm",
	"--font-family",
	"--font-size",
	"--font-weight-ui",
	"--panel-border-width",
	"--backdrop-blur",
	"--press-offset",
	"--gap",
	"--pad",
	"color-scheme",
] as const;

function setOptionalColor(root: HTMLElement, prop: string, value: string): void {
	if (value) root.style.setProperty(prop, value);
	else root.style.removeProperty(prop);
}

/** Writes a custom palette onto `root` (live preview + saved custom themes). */
export function applyCustomPalette(root: HTMLElement, colors: ThemeColors, mode: ThemeMode): void {
	root.dataset.theme = "custom";
	root.style.setProperty("color-scheme", mode);
	root.style.setProperty("--bg", colors.bg);
	root.style.setProperty("--fg", colors.fg);
	root.style.setProperty("--muted", colors.muted);
	root.style.setProperty("--row-bg", colors.row_bg);
	root.style.setProperty("--accent", colors.accent);
	root.style.setProperty("--accent-fg", colors.accent_fg);
	root.style.setProperty("--border", colors.border);
	root.style.setProperty("--bg-alpha", `${colors.bg_alpha}%`);
	root.style.setProperty("--row-alpha", `${colors.row_alpha}%`);
	setOptionalColor(root, "--input-bg", colors.input_bg);
	setOptionalColor(root, "--input-fg", colors.input_fg);
	setOptionalColor(root, "--input-border", colors.input_border);
	setOptionalColor(root, "--button-bg", colors.button_bg);
	setOptionalColor(root, "--button-fg", colors.button_fg);
	setOptionalColor(root, "--selected-bg", colors.selected_bg);
	setOptionalColor(root, "--hover-bg", colors.hover_bg);
	setOptionalColor(root, "--danger", colors.danger);
	setOptionalColor(root, "--meta", colors.meta);
	root.style.setProperty("--radius", `${colors.radius}px`);
	root.style.setProperty("--window-radius", `${colors.window_radius}px`);
	root.style.setProperty("--radius-sm", `${colors.radius_sm}px`);
	root.style.setProperty("--font-size", `${colors.font_size}px`);
	root.style.setProperty("--font-weight-ui", String(colors.font_weight));
	root.style.setProperty("--panel-border-width", `${colors.border_width}px`);
	root.style.setProperty("--backdrop-blur", `${colors.backdrop_blur}px`);
	root.style.setProperty("--press-offset", `${colors.press_offset}px`);
	root.style.setProperty("--gap", `${colors.gap}px`);
	root.style.setProperty("--pad", `${colors.pad}px`);
	if (colors.font_family) root.style.setProperty("--font-family", colors.font_family);
	else root.style.removeProperty("--font-family");
}

export function clearCustomPalette(root: HTMLElement): void {
	for (const prop of CUSTOM_STYLE_PROPS) root.style.removeProperty(prop);
}

export function findThemeByName(query: string): ThemeDef | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	const compact = q.replace(/[\s_-]+/g, "");
	return (
		THEMES.find((t) => t.id === q) ??
		THEMES.find((t) => t.label.toLowerCase() === q) ??
		THEMES.find((t) => t.id.replace(/[\s_-]+/g, "") === compact) ??
		THEMES.find((t) => t.label.toLowerCase().includes(q)) ??
		THEMES.find((t) => t.label.toLowerCase().replace(/[\s_-]+/g, "").includes(compact)) ??
		null
	);
}
