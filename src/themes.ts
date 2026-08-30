/**
 * Theme registry (data only, no DOM) — ported from shiftshift's `themes.ts`,
 * same theme set and light/dark "family" pairing so `/light` and `/dark`
 * can jump to the sibling of whatever theme is active. Each id maps to a
 * `[data-theme="<id>"]` CSS variable block in `style.css`.
 */

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
	| "solarized-light";

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
export function findThemeByName(query: string): ThemeDef | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	return (
		THEMES.find((t) => t.id === q) ??
		THEMES.find((t) => t.label.toLowerCase() === q) ??
		THEMES.find((t) => t.label.toLowerCase().includes(q)) ??
		null
	);
}
