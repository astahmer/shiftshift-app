import { describe, expect, it } from "vitest";
import { createConfigBackup, parseConfigBackup } from "./config-backup";
import type { CustomTheme, Settings, Template } from "./store";

const settings = {
	bindings: { left: "capture", right: "toggle_panel" },
	theme: "tokyo-night",
	s3: {
		endpoint: "https://s3.example.com",
		bucket: "shiftshift",
		region: "auto",
		access_key_id: "access",
		secret_access_key: "do-not-export",
		prefix: "items",
	},
	automation_hooks: [
		{
			id: "auto-classify",
			enabled: true,
			events: ["item.created"],
		command: "/Users/me/bin/shiftshift-classify",
		args: [],
		timeout_ms: 10000,
		views: [
			{
				id: "work-queue",
				label: "Work queue",
				description: "Unfinished work",
				icon: "▣",
				sort: "newest",
				enabled: true,
				query: { all: [], any: [], none: [] },
			},
		],
		},
	],
} as unknown as Settings;

const templates: Template[] = [{ id: "template-1", name: "standup", body: "done: {{a}}" }];
const customThemes: CustomTheme[] = [
	{
		id: "theme-1",
		name: "Midnight",
		mode: "dark",
		colors: {
			bg: "#111",
			fg: "#eee",
			muted: "#888",
			row_bg: "#222",
			accent: "#5af",
			accent_fg: "#000",
			border: "#333",
		} as CustomTheme["colors"],
	},
];

describe("config backup", () => {
	it("includes settings, templates, and themes without exporting the S3 secret", () => {
		const backup = createConfigBackup(settings, templates, customThemes);

		expect(backup.version).toBe(1);
		expect(backup.templates).toEqual(templates);
		expect(backup.custom_themes).toEqual(customThemes);
		expect(backup.settings.s3.secret_access_key).toBe("");
		expect(backup.settings.automation_hooks).toEqual(settings.automation_hooks);
	});

	it("restores empty collections instead of leaving stale local values behind", () => {
		const parsed = parseConfigBackup({ settings, templates: [], custom_themes: [] });

		expect(parsed.templates).toEqual([]);
		expect(parsed.customThemes).toEqual([]);
	});

	it("keeps older settings-only exports compatible", () => {
		const parsed = parseConfigBackup({ settings: { bindings: settings.bindings, theme: "dracula" } });

		expect(parsed.settings.theme).toBe("dracula");
		expect(parsed.templates).toBeUndefined();
		expect(parsed.customThemes).toBeUndefined();
	});

	it("rejects an unsupported version", () => {
		expect(() => parseConfigBackup({ version: 2, settings })).toThrow("unsupported config backup version");
	});
});
