import { isImportableTheme, normalizeThemeColors } from "./capture-logic";
import type { CustomTheme, S3Settings, Settings, Template, ThemeColors } from "./store";

export const CONFIG_BACKUP_VERSION = 1;

export type ConfigBackup = {
	version: typeof CONFIG_BACKUP_VERSION;
	settings: Settings;
	templates: Template[];
	custom_themes: CustomTheme[];
};

export type ParsedConfigBackup = {
	settings: Partial<Settings>;
	templates?: Template[];
	customThemes?: CustomTheme[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the portable config shape while keeping Keychain-backed secrets out of it. */
export function createConfigBackup(
	settings: Settings,
	templates: Template[],
	customThemes: CustomTheme[],
): ConfigBackup {
	return {
		version: CONFIG_BACKUP_VERSION,
		settings: {
			...settings,
			s3: { ...settings.s3, secret_access_key: "" },
		},
		templates: templates.map((template) => ({ ...template })),
		custom_themes: customThemes.map((theme) => ({ ...theme, colors: { ...theme.colors } })),
	};
}

function parseTemplates(value: unknown): Template[] {
	if (!Array.isArray(value)) throw new Error("templates must be an array");
	const seen = new Set<string>();
	const templates: Template[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
		if (typeof entry.name !== "string" || !entry.name.trim()) continue;
		if (typeof entry.body !== "string" || !entry.body.trim()) continue;
		seen.add(entry.id);
		templates.push({ id: entry.id, name: entry.name, body: entry.body });
	}
	return templates;
}

function parseCustomThemes(value: unknown): CustomTheme[] {
	if (!Array.isArray(value)) throw new Error("custom_themes must be an array");
	const seen = new Set<string>();
	const themes: CustomTheme[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
		if (!isImportableTheme(entry)) continue;
		const theme = entry as {
			id: string;
			name: string;
			mode: "light" | "dark";
			colors: ThemeColors;
		};
		seen.add(theme.id);
		themes.push({
			id: theme.id,
			name: theme.name,
			mode: theme.mode,
			colors: normalizeThemeColors(theme.colors),
		});
	}
	return themes;
}

/**
 * Parses both the versioned full backup and the older settings-only shape.
 * Optional collections are returned only when present, so old exports don't
 * accidentally delete templates or themes during import.
 */
export function parseConfigBackup(parsed: unknown): ParsedConfigBackup {
	if (!isRecord(parsed)) throw new Error("not a shiftshift settings export");
	if (parsed.version !== undefined && parsed.version !== CONFIG_BACKUP_VERSION) {
		throw new Error(`unsupported config backup version: ${String(parsed.version)}`);
	}

	const nestedSettings =
		isRecord(parsed.settings) && "bindings" in parsed.settings ? parsed.settings : null;
	const settingsRecord = nestedSettings ?? ("bindings" in parsed ? parsed : null);
	if (!settingsRecord || !isRecord(settingsRecord.bindings))
		throw new Error("not a shiftshift settings export");

	const settings = { ...settingsRecord } as Partial<Settings>;
	if ("s3" in settingsRecord) {
		if (!isRecord(settingsRecord.s3)) throw new Error("invalid S3 settings");
		// Secrets are machine-local Keychain data, never part of a portable config.
		settings.s3 = { ...settingsRecord.s3, secret_access_key: "" } as S3Settings;
	}

	const result: ParsedConfigBackup = { settings };
	if ("templates" in parsed) result.templates = parseTemplates(parsed.templates);
	if ("custom_themes" in parsed) result.customThemes = parseCustomThemes(parsed.custom_themes);
	return result;
}
