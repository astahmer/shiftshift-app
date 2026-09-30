import { describe, expect, it } from "vitest";
import {
	applySort,
	buildListTabs,
	copyableItemText,
	detectKind,
	expandTemplate,
	extractTags,
	emptyTabCopy,
	filterItems,
	findDuplicate,
	itemsForTab,
	nextListTab,
	formatRelativeTime,
	isImportableTheme,
	lastToken,
	fuzzyMatch,
	HELP_SHORTCUTS,
	matchAtSuggestions,
	matchHashSuggestions,
	matchHelpEntries,
	matchSlashSuggestions,
	matchSortSuggestions,
	matchThemeSuggestions,
	matchesCollectionQuery,
	parseInlineMarkdown,
	parseSlashMode,
	parseUiCommand,
	resolveCapture,
	slashSuggestionIsImmediate,
	settingsSearchMatches,
	extendRangeByIds,
	fileUrlFromPath,
	itemExternalDragText,
	rankForDrop,
	replaceLastToken,
	applyListDrag,
	pointerLeftWindow,
	listDragNeedsSyntheticDown,
} from "./capture-logic";
import type { AutomationView, Collection, Item, Template } from "./store";

function item(overrides: Partial<Item> & Pick<Item, "text">): Item {
	return {
		id: overrides.text,
		kind: "note",
		done: false,
		tags: [],
		bookmarked: false,
		rank: 0,
		source_app: null,
		created_at: "2026-01-01T00:00:00Z",
		copy_count: 0,
		first_copied_at: null,
		last_copied_at: null,
		...overrides,
	};
}

describe("detectKind", () => {
	it("classifies a bare URL as a link", () => {
		expect(detectKind("https://example.com/path")).toBe("link");
	});

	it("classifies plain text as a note", () => {
		expect(detectKind("just some text")).toBe("note");
	});

	it("does not classify a URL embedded in a sentence as a link", () => {
		expect(detectKind("see https://example.com for details")).toBe("note");
	});
});

describe("expandTemplate", () => {
	it("substitutes a single placeholder", () => {
		expect(expandTemplate("did: {{a}}", ["shipped the thing"])).toBe("did: shipped the thing");
	});

	it("substitutes multiple placeholders in first-appearance order", () => {
		expect(expandTemplate("{{a}} then {{b}}", ["first", "second"])).toBe("first then second");
	});

	it("reuses the same arg for a repeated placeholder name", () => {
		expect(expandTemplate("{{name}} says hi to {{name}}", ["Ada"])).toBe("Ada says hi to Ada");
	});

	it("fills a missing arg with an empty string", () => {
		expect(expandTemplate("{{a}} and {{b}}", ["only"])).toBe("only and ");
	});

	it("leaves text with no placeholders untouched", () => {
		expect(expandTemplate("no placeholders here", ["unused"])).toBe("no placeholders here");
	});
});

describe("resolveCapture", () => {
	const templates: Template[] = [{ id: "1", name: "standup", body: "did: {{a}}\nblockers: {{b}}" }];

	it("strips the /todo prefix and forces the todo kind", () => {
		expect(resolveCapture("/todo buy milk", [])).toEqual({ text: "buy milk", kind: "todo" });
	});

	it("expands a matching template with positional args", () => {
		expect(resolveCapture("/standup shipped it nothing", templates)).toEqual({
			text: "did: shipped\nblockers: it",
			kind: "note",
		});
	});

	it("falls back to literal text when no template matches the slash command", () => {
		expect(resolveCapture("/unknown foo", templates)).toEqual({
			text: "/unknown foo",
			kind: "note",
		});
	});

	it("classifies an expanded template as a link when it resolves to a URL", () => {
		const linkTemplates: Template[] = [{ id: "2", name: "site", body: "https://{{host}}" }];
		expect(resolveCapture("/site example.com", linkTemplates)).toEqual({
			text: "https://example.com",
			kind: "link",
		});
	});

	it("passes plain text through unchanged", () => {
		expect(resolveCapture("just a note", [])).toEqual({ text: "just a note", kind: "note" });
	});
});

describe("parseUiCommand", () => {
	it("recognizes /settings", () => {
		expect(parseUiCommand("/settings")).toEqual({ type: "open-settings" });
	});

	it("recognizes /quit", () => {
		expect(parseUiCommand("/quit")).toEqual({ type: "quit" });
	});

	it("runs settings immediately from a highlighted /sett suggestion", () => {
		expect(slashSuggestionIsImmediate("settings")).toBe(true);
		expect(slashSuggestionIsImmediate("theme")).toBe(false);
	});

	it("returns null for anything else, including the now-dedicated theme/sort/history commands", () => {
		expect(parseUiCommand("/todo buy milk")).toBeNull();
		expect(parseUiCommand("just text")).toBeNull();
		expect(parseUiCommand("/theme dracula")).toBeNull();
		expect(parseUiCommand("/light")).toBeNull();
	});
});

describe("findDuplicate", () => {
	const items = [item({ text: "buy milk" }), item({ text: "call mom" })];

	it("finds a case-insensitive exact match", () => {
		expect(findDuplicate(items, "Buy Milk")).toEqual(items[0]);
	});

	it("returns null when nothing matches", () => {
		expect(findDuplicate(items, "buy bread")).toBeNull();
	});

	it("returns null for empty text", () => {
		expect(findDuplicate(items, "   ")).toBeNull();
	});
});

describe("filterItems", () => {
	const items = [
		item({ text: "buy milk", kind: "todo" }),
		item({ text: "https://example.com", kind: "link", bookmarked: true }),
		item({ text: "idea about ships", kind: "note" }),
	];

	it("substring-matches plain text against item text, case-insensitively", () => {
		expect(filterItems(items, "SHIP").map((i) => i.text)).toEqual(["idea about ships"]);
	});

	it("filters by the @bookmarks tag", () => {
		expect(filterItems(items, "@bookmarks").map((i) => i.text)).toEqual(["https://example.com"]);
	});

	it("filters by the equivalent has:link form", () => {
		expect(filterItems(items, "has:link").map((i) => i.text)).toEqual(["https://example.com"]);
	});

	it("combines a tag with a text query", () => {
		expect(filterItems(items, "@todos milk").map((i) => i.text)).toEqual(["buy milk"]);
		expect(filterItems(items, "@todos bread")).toEqual([]);
	});

	it("returns everything for an empty query", () => {
		expect(filterItems(items, "")).toEqual(items);
	});
});

describe("list tabs", () => {
	const items = [
		item({ text: "buy milk", kind: "todo" }),
		item({ text: "https://example.com", kind: "link", bookmarked: true }),
		item({ text: "shot", kind: "image" }),
		item({ text: "idea #work", kind: "note" }),
		item({ text: "call mom #home #urgent", kind: "note" }),
	];

	it("scopes the list to the active tab", () => {
		expect(itemsForTab(items, "recent")).toEqual(items);
		expect(itemsForTab(items, "bookmarked").map((row) => row.text)).toEqual([
			"https://example.com",
		]);
		expect(itemsForTab(items, "images").map((row) => row.text)).toEqual(["shot"]);
		expect(itemsForTab(items, "todos").map((row) => row.text)).toEqual(["buy milk"]);
	});

	it("scopes a per-tag tab to items carrying that tag", () => {
		expect(itemsForTab(items, "tag:work").map((row) => row.text)).toEqual(["idea #work"]);
		expect(itemsForTab(items, "tag:urgent").map((row) => row.text)).toEqual([
			"call mom #home #urgent",
		]);
	});

	it("scopes the combined tags tab to the union of selected tags", () => {
		expect(itemsForTab(items, "tags")).toEqual([]);
		expect(itemsForTab(items, "tags", new Set())).toEqual([]);
		expect(itemsForTab(items, "tags", new Set(["work"])).map((row) => row.text)).toEqual([
			"idea #work",
		]);
		expect(itemsForTab(items, "tags", new Set(["work", "home"])).map((row) => row.text)).toEqual([
			"idea #work",
			"call mom #home #urgent",
		]);
	});

	it("builds one tab per distinct tag by default", () => {
		const tabs = buildListTabs(items, true);
		expect(tabs.map((tab) => tab.id)).toEqual([
			"recent",
			"bookmarked",
			"images",
			"todos",
			"tag:home",
			"tag:urgent",
			"tag:work",
		]);
	});

	it("builds a single combined Tags tab when disabled", () => {
		const tabs = buildListTabs(items, false);
		expect(tabs.map((tab) => tab.id)).toEqual(["recent", "bookmarked", "images", "todos", "tags"]);
	});

	it("adds saved collections and enabled automation views as tabs", () => {
		const collection: Collection = {
			id: "work",
			name: "Work queue",
			query: { all: [], any: [], none: [] },
			sort: "newest",
			rank: 1,
			icon: "▣",
			color: null,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
		const view: AutomationView = {
			id: "organizer:follow-up",
			label: "Follow-up",
			description: "Open follow-up items",
			icon: "↗",
			query: { all: [], any: [], none: [] },
			sort: "oldest",
			enabled: true,
		};
		const tabs = buildListTabs([], true, [collection], [view]);
		expect(tabs.map((tab) => tab.id)).toContain("collection:work");
		expect(tabs.map((tab) => tab.id)).toContain("automation:organizer:follow-up");
		expect(tabs.find((tab) => tab.id === "collection:work")?.label).toBe("▣ Work queue");
	});

	it("evaluates collection and plugin queries against first-class tags", () => {
		const tagged = item({
			text: "send the report",
			kind: "todo",
			tags: ["Work"],
			source_app: "Mail",
		});
		const query = {
			all: [
				{ field: "tag" as const, operator: "equals" as const, value: "work" },
				{ field: "done" as const, operator: "equals" as const, value: "false" },
			],
			any: [{ field: "kind" as const, operator: "equals" as const, value: "todo" }],
			none: [{ field: "bookmarked" as const, operator: "equals" as const, value: "true" }],
		};
		expect(matchesCollectionQuery(tagged, query)).toBe(true);
		expect(
			itemsForTab([tagged], "collection:work", undefined, [
				{
					id: "work",
					name: "Work",
					query,
					sort: "manual",
					rank: 0,
					icon: null,
					color: null,
					created_at: "",
					updated_at: "",
				},
			]),
		).toEqual([tagged]);
		expect(
			itemsForTab(
				[tagged],
				"automation:organizer:follow-up",
				undefined,
				[],
				[
					{
						id: "organizer:follow-up",
						label: "Follow-up",
						description: "",
						icon: "",
						query,
						sort: "manual",
						enabled: true,
					},
				],
			),
		).toEqual([tagged]);
	});

	it("wraps Tab cycling in both directions", () => {
		const tabs = buildListTabs([], true);
		expect(nextListTab(tabs, "recent", 1)).toBe("bookmarked");
		expect(nextListTab(tabs, "todos", 1)).toBe("recent");
		expect(nextListTab(tabs, "recent", -1)).toBe("todos");
	});

	it("uses a filter empty-state when a query is active", () => {
		expect(emptyTabCopy("todos", true).title).toBe("No matches");
		expect(emptyTabCopy("todos", false).title).toBe("No TODOs");
	});

	it("prompts for a tag selection before showing the combined tags empty-state", () => {
		expect(emptyTabCopy("tags", false, 0).title).toBe("Pick a tag");
		expect(emptyTabCopy("tags", false, 1).title).toBe("No matches");
	});

	it("names the tag in a per-tag tab's empty-state", () => {
		expect(emptyTabCopy("tag:work", false).body).toContain("#work");
	});
});

describe("applySort", () => {
	const items = [
		item({ text: "banana", created_at: "2026-01-02T00:00:00Z" }),
		item({ text: "apple", created_at: "2026-01-03T00:00:00Z" }),
		item({ text: "cherry", created_at: "2026-01-01T00:00:00Z" }),
	];

	it("leaves manual order untouched", () => {
		expect(applySort(items, "manual")).toBe(items);
	});

	it("sorts newest first by created_at", () => {
		expect(applySort(items, "newest").map((i) => i.text)).toEqual(["apple", "banana", "cherry"]);
	});

	it("sorts oldest first by created_at", () => {
		expect(applySort(items, "oldest").map((i) => i.text)).toEqual(["cherry", "banana", "apple"]);
	});

	it("sorts A-Z by text", () => {
		expect(applySort(items, "az").map((i) => i.text)).toEqual(["apple", "banana", "cherry"]);
	});

	it("sorts Z-A by text", () => {
		expect(applySort(items, "za").map((i) => i.text)).toEqual(["cherry", "banana", "apple"]);
	});

	it("keeps bookmarked items pinned above unbookmarked ones regardless of sort mode", () => {
		const mixed = [
			item({ text: "zzz", bookmarked: true }),
			item({ text: "aaa", bookmarked: false }),
		];
		expect(applySort(mixed, "az").map((i) => i.text)).toEqual(["zzz", "aaa"]);
	});
});

describe("matchSortSuggestions", () => {
	it("returns all options for an empty query", () => {
		expect(matchSortSuggestions("").map((o) => o.mode)).toEqual([
			"manual",
			"newest",
			"oldest",
			"az",
			"za",
		]);
	});

	it("narrows by label substring", () => {
		expect(matchSortSuggestions("newest").map((o) => o.mode)).toEqual(["newest"]);
	});
});

describe("matchSlashSuggestions", () => {
	const templates: Template[] = [{ id: "1", name: "standup", body: "did: {{a}}" }];

	it("matches builtins and templates by prefix", () => {
		const names = matchSlashSuggestions("/s", templates).map((s) => s.name);
		expect(names).toEqual(expect.arrayContaining(["settings", "sort", "standup"]));
		expect(names).not.toContain("todo");
	});

	it("keeps matching the same command once args are typed", () => {
		const names = matchSlashSuggestions("/standup shipped it", templates).map((s) => s.name);
		expect(names).toEqual(["standup"]);
	});

	it("returns everything for a bare slash", () => {
		const names = matchSlashSuggestions("/", templates).map((s) => s.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"todo",
				"settings",
				"light",
				"dark",
				"theme",
				"sort",
				"history",
				"help",
				"standup",
			]),
		);
	});

	it("returns nothing when no command matches the prefix", () => {
		expect(matchSlashSuggestions("/zzz", templates)).toEqual([]);
	});
});

describe("parseSlashMode", () => {
	it("recognizes /theme with and without a query", () => {
		expect(parseSlashMode("/theme")).toEqual({ type: "theme", query: "" });
		expect(parseSlashMode("/theme drac")).toEqual({ type: "theme", query: "drac" });
	});

	it("recognizes /light and /dark", () => {
		expect(parseSlashMode("/light")).toEqual({ type: "light" });
		expect(parseSlashMode("/dark")).toEqual({ type: "dark" });
	});

	it("recognizes /sort with and without a query", () => {
		expect(parseSlashMode("/sort")).toEqual({ type: "sort", query: "" });
		expect(parseSlashMode("/sort new")).toEqual({ type: "sort", query: "new" });
	});

	it("recognizes /history", () => {
		expect(parseSlashMode("/history")).toEqual({ type: "history", query: "" });
	});

	it("recognizes /help with and without a query", () => {
		expect(parseSlashMode("/help")).toEqual({ type: "help", query: "" });
		expect(parseSlashMode("/help tag")).toEqual({ type: "help", query: "tag" });
	});

	it("fuzzyMatch requires every query character in order, gaps allowed", () => {
		expect(fuzzyMatch("tg", "Filter/tag by hashtag")?.ranges).toBeTruthy();
		expect(fuzzyMatch("xyz", "Filter/tag by hashtag")).toBeNull();
	});

	it("fuzzyMatch's ranges cover exactly the matched characters", () => {
		expect(fuzzyMatch("tag", "a tag")?.ranges).toEqual([[2, 5]]);
	});

	it("matchHelpEntries returns everything, unfiltered, for an empty query", () => {
		expect(matchHelpEntries("").length).toBe(HELP_SHORTCUTS.length);
	});

	it("matchHelpEntries narrows to entries whose description matches, with highlight ranges", () => {
		const results = matchHelpEntries("hashtag");
		expect(results.some((r) => r.description.includes("hashtag"))).toBe(true);
		expect(results.every((r) => r.description.toLowerCase().includes("hashtag"))).toBe(true);
		expect(results[0]!.descriptionRanges.length).toBeGreaterThan(0);
	});

	it("matchHelpEntries returns nothing for a query no description contains", () => {
		expect(matchHelpEntries("zzzzz")).toEqual([]);
	});

	it("does not switch modes on a partial word (e.g. /th before /theme)", () => {
		expect(parseSlashMode("/th")).toEqual({ type: "commands" });
	});

	it("falls back to commands for anything else", () => {
		expect(parseSlashMode("/todo buy milk")).toEqual({ type: "commands" });
	});
});

describe("matchThemeSuggestions", () => {
	const themes = [
		{ id: "a", label: "Tokyo Night", mode: "dark" as const },
		{ id: "b", label: "Tokyo Night Day", mode: "light" as const },
		{ id: "c", label: "Dracula", mode: "dark" as const },
	];

	it("filters by label substring", () => {
		expect(matchThemeSuggestions("tokyo", themes).map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("also matches ids and compact labels (win95, windows95)", () => {
		const os = [
			{ id: "win95", label: "Windows 95", mode: "light" as const },
			{ id: "mac", label: "macOS", mode: "light" as const },
		];
		expect(matchThemeSuggestions("win95", os).map((t) => t.id)).toEqual(["win95"]);
		expect(matchThemeSuggestions("windows95", os).map((t) => t.id)).toEqual(["win95"]);
		expect(matchThemeSuggestions("macos", os).map((t) => t.id)).toEqual(["mac"]);
	});

	it("filters by mode", () => {
		expect(matchThemeSuggestions("", themes, "light").map((t) => t.id)).toEqual(["b"]);
	});

	it("returns everything for an empty query and no mode filter", () => {
		expect(matchThemeSuggestions("", themes)).toEqual(themes);
	});
});

describe("lastToken", () => {
	it("returns the final word", () => {
		expect(lastToken("foo @bar")).toBe("@bar");
	});

	it("returns an empty string when the input ends in whitespace", () => {
		expect(lastToken("foo @bar ")).toBe("");
	});
});

describe("matchAtSuggestions", () => {
	it("matches filter tags by prefix", () => {
		expect(matchAtSuggestions("@to").map((t) => t.tag)).toEqual(["todos"]);
	});

	it("returns everything for a bare @", () => {
		expect(matchAtSuggestions("@").map((t) => t.tag)).toEqual([
			"bookmarks",
			"links",
			"todos",
			"notes",
			"images",
		]);
	});
});

describe("formatRelativeTime", () => {
	const now = new Date("2026-01-02T00:00:00Z").getTime();

	it("says just now for very recent times", () => {
		expect(formatRelativeTime("2026-01-02T00:00:00Z", now)).toBe("just now");
	});

	it("formats minutes", () => {
		expect(formatRelativeTime("2026-01-01T23:55:00Z", now)).toBe("5m");
	});

	it("formats hours", () => {
		expect(formatRelativeTime("2026-01-01T18:00:00Z", now)).toBe("6h");
	});

	it("formats days", () => {
		expect(formatRelativeTime("2025-12-30T00:00:00Z", now)).toBe("3d");
	});

	it("returns an empty string for an invalid date", () => {
		expect(formatRelativeTime("not a date", now)).toBe("");
	});
});

describe("parseInlineMarkdown", () => {
	it("passes plain text through as a single text segment", () => {
		expect(parseInlineMarkdown("hello world")).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("parses bold, italic, and code spans", () => {
		expect(parseInlineMarkdown("**bold** *italic* `code`")).toEqual([
			{ type: "bold", text: "bold" },
			{ type: "text", text: " " },
			{ type: "italic", text: "italic" },
			{ type: "text", text: " " },
			{ type: "code", text: "code" },
		]);
	});

	it("mixes markdown spans with surrounding text", () => {
		expect(parseInlineMarkdown("do **this** now")).toEqual([
			{ type: "text", text: "do " },
			{ type: "bold", text: "this" },
			{ type: "text", text: " now" },
		]);
	});

	it("returns a single empty text segment for empty input", () => {
		expect(parseInlineMarkdown("")).toEqual([{ type: "text", text: "" }]);
	});

	it("parses a hashtag as a tag segment", () => {
		expect(parseInlineMarkdown("check #work later")).toEqual([
			{ type: "text", text: "check " },
			{ type: "tag", text: "#work" },
			{ type: "text", text: " later" },
		]);
	});

	it("does not treat a numeric reference as a hashtag", () => {
		expect(parseInlineMarkdown("fixes #482")).toEqual([{ type: "text", text: "fixes #482" }]);
	});
});

describe("copyableItemText", () => {
	it("removes inline hashtags from copied notes", () => {
		expect(copyableItemText(item({ text: "ship it #work" }))).toBe("ship it");
		expect(copyableItemText(item({ text: "#work ship it #today" }))).toBe("ship it");
	});

	it("keeps non-tag text and numeric references intact", () => {
		expect(copyableItemText(item({ text: "fixes #482" }))).toBe("fixes #482");
		expect(copyableItemText(item({ text: "  keep  this  " }))).toBe("  keep  this  ");
		expect(copyableItemText(item({ text: "keep  this #tag now" }))).toBe("keep  this now");
	});

	it("does not strip URL fragments or image paths", () => {
		expect(copyableItemText(item({ kind: "link", text: "https://example.com/#section" }))).toBe(
			"https://example.com/#section",
		);
		expect(copyableItemText(item({ kind: "image", text: "/tmp/shot#1.png" }))).toBe(
			"/tmp/shot#1.png",
		);
	});

	it("does not remove hashtag-looking text inside code or emphasis", () => {
		expect(copyableItemText(item({ text: "`#literal` **#also-literal** #metadata" }))).toBe(
			"`#literal` **#also-literal**",
		);
	});
});

describe("extractTags", () => {
	it("collects unique lowercased hashtags across items", () => {
		const list = [item({ text: "plan #Work stuff" }), item({ text: "more #work and #life" })];
		expect(extractTags(list)).toEqual(["life", "work"]);
	});

	it("ignores numeric-only references", () => {
		expect(extractTags([item({ text: "see issue #482" })])).toEqual([]);
	});

	it("includes first-class metadata tags alongside legacy inline tags", () => {
		expect(extractTags([item({ text: "plain note", tags: ["Work", "project-x"] })])).toEqual([
			"project-x",
			"work",
		]);
	});
});

describe("matchHashSuggestions", () => {
	const list = [item({ text: "#work" }), item({ text: "#worship" }), item({ text: "#life" })];

	it("filters existing tags by prefix", () => {
		expect(matchHashSuggestions("#wor", list)).toEqual(["work", "worship"]);
	});

	it("returns everything for a bare #", () => {
		expect(matchHashSuggestions("#", list)).toEqual(["life", "work", "worship"]);
	});
});

describe("isImportableTheme", () => {
	const colors = {
		bg: "#000",
		fg: "#fff",
		muted: "#888",
		row_bg: "#111",
		accent: "#5af",
		accent_fg: "#000",
		border: "#222",
	};

	it("accepts a well-formed theme", () => {
		expect(isImportableTheme({ name: "Midnight", mode: "dark", colors })).toBe(true);
	});

	it("rejects a missing color", () => {
		const { bg: _bg, ...incomplete } = colors;
		expect(isImportableTheme({ name: "Midnight", mode: "dark", colors: incomplete })).toBe(false);
	});

	it("rejects an invalid mode", () => {
		expect(isImportableTheme({ name: "Midnight", mode: "blue", colors })).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isImportableTheme(null)).toBe(false);
		expect(isImportableTheme("not an object")).toBe(false);
	});
});

describe("settingsSearchMatches", () => {
	it("treats dock as related to edge / notch / position", () => {
		expect(settingsSearchMatches("dock", "Position")).toBe(true);
		expect(settingsSearchMatches("dock", "Show recent-items dock")).toBe(true);
		expect(settingsSearchMatches("edge", "Dock notch pill recent")).toBe(true);
	});

	it("still requires a real relation — unrelated rows stay hidden", () => {
		expect(settingsSearchMatches("dock", "Encrypt local database")).toBe(false);
		expect(settingsSearchMatches("theme", "Fallback shortcuts")).toBe(false);
	});

	it("covers the other settings clusters too", () => {
		expect(settingsSearchMatches("pin", "Pinned quick-access")).toBe(true);
		expect(settingsSearchMatches("shortcut", "Fallback shortcuts")).toBe(true);
		expect(settingsSearchMatches("sync", "Encrypt local database")).toBe(true);
		expect(settingsSearchMatches("snippet", "Snippet templates")).toBe(true);
		expect(settingsSearchMatches("font", "Appearance theme look")).toBe(true);
		expect(
			settingsSearchMatches("spellcheck", "Autocorrect / spellcheck on the capture input"),
		).toBe(true);
		expect(settingsSearchMatches("bonjour", "Autocorrect / spellcheck on the capture input")).toBe(
			true,
		);
	});
});

describe("rankForDrop", () => {
	const a = item({ text: "a", id: "a", rank: 3000 });
	const b = item({ text: "b", id: "b", rank: 2000 });
	const c = item({ text: "c", id: "c", rank: 1000 });
	const visible = [a, b, c];

	it("drops before the first item with a higher rank", () => {
		const rank = rankForDrop(visible, "c", 0);
		expect(rank).toBeGreaterThan(a.rank);
	});

	it("drops between two neighbors", () => {
		const rank = rankForDrop(visible, "c", 1);
		expect(rank).toBeGreaterThan(b.rank);
		expect(rank).toBeLessThan(a.rank);
	});

	it("drops after the last item with a lower rank", () => {
		const rank = rankForDrop(visible, "a", 3);
		expect(rank).toBeLessThan(c.rank);
	});

	it("adjusts the insert index when the dragged row sits before the target", () => {
		const rank = rankForDrop(visible, "a", 2);
		expect(rank).toBeGreaterThan(c.rank);
		expect(rank).toBeLessThan(b.rank);
	});
});

describe("list drag gesture e2e", () => {
	it("keeps a note in-list so it can be rearranged", () => {
		let state = applyListDrag(null, { type: "down", id: "a", index: 0, x: 10, y: 10 }).state;
		const start = applyListDrag(state, {
			type: "move",
			x: 10,
			y: 40,
			overIndex: 2,
			leftWindow: false,
		});
		expect(start.effect).toEqual({ type: "reorder", overIndex: 2 });
		state = start.state;
		const up = applyListDrag(state, { type: "up" });
		expect(up.effect).toEqual({ type: "commit", id: "a", from: 0, over: 2 });
		expect(up.state).toBeNull();
	});

	it("does not start an external drag on the first move", () => {
		const state = applyListDrag(null, { type: "down", id: "note", index: 1, x: 20, y: 20 }).state;
		const move = applyListDrag(state, {
			type: "move",
			x: 24,
			y: 22,
			overIndex: 1,
			leftWindow: false,
		});
		expect(move.effect).toEqual({ type: "none" });
		expect(move.state?.live).toBe(false);
	});

	it("starts an external drag only after the pointer leaves the window", () => {
		let state = applyListDrag(null, { type: "down", id: "note", index: 0, x: 10, y: 10 }).state;
		state = applyListDrag(state, {
			type: "move",
			x: 10,
			y: 30,
			overIndex: 0,
			leftWindow: false,
		}).state;
		expect(state?.live).toBe(true);
		const leave = applyListDrag(state, {
			type: "move",
			x: -4,
			y: 30,
			overIndex: 0,
			leftWindow: true,
		});
		expect(leave.effect).toEqual({ type: "external", id: "note" });
		expect(leave.state).toBeNull();
	});

	it("starts an external drag on pointerleave after the gesture is live", () => {
		let state = applyListDrag(null, { type: "down", id: "link", index: 2, x: 8, y: 8 }).state;
		state = applyListDrag(state, {
			type: "move",
			x: 8,
			y: 40,
			overIndex: 2,
			leftWindow: false,
		}).state;
		const leave = applyListDrag(state, { type: "leave" });
		expect(leave.effect).toEqual({ type: "external", id: "link" });
	});

	it("starts an external drag when the pointer leaves before the 8px threshold", () => {
		const state = applyListDrag(null, { type: "down", id: "note", index: 0, x: 2, y: 2 }).state;
		const leave = applyListDrag(state, {
			type: "move",
			x: -1,
			y: 2,
			overIndex: 0,
			leftWindow: true,
		});
		expect(leave.effect).toEqual({ type: "external", id: "note" });
	});

	it("starts an external drag on pointerleave even before the gesture is live", () => {
		const state = applyListDrag(null, { type: "down", id: "note", index: 0, x: 4, y: 4 }).state;
		const leave = applyListDrag(state, { type: "leave" });
		expect(leave.effect).toEqual({ type: "external", id: "note" });
	});

	it("does not treat a click as reorder or drag-out", () => {
		const state = applyListDrag(null, { type: "down", id: "a", index: 0, x: 10, y: 10 }).state;
		const up = applyListDrag(state, { type: "up" });
		expect(up.effect).toEqual({ type: "none" });
	});

	it("uses the same leave geometry for both panels", () => {
		expect(pointerLeftWindow(-1, 10, 400, 300)).toBe(true);
		expect(pointerLeftWindow(10, 10, 400, 300)).toBe(false);
		expect(pointerLeftWindow(401, 10, 400, 300)).toBe(true);
	});

	it("recovers a missed pointerdown when the window was unfocused", () => {
		expect(listDragNeedsSyntheticDown(null, 1)).toBe(true);
		expect(listDragNeedsSyntheticDown(null, 0)).toBe(false);
		const state = applyListDrag(null, { type: "down", id: "a", index: 0, x: 1, y: 1 }).state;
		expect(listDragNeedsSyntheticDown(state, 1)).toBe(false);
	});

	it("turns a recovered press into drag-out as soon as the pointer leaves", () => {
		let state = applyListDrag(null, { type: "down", id: "note", index: 0, x: 2, y: 2 }).state;
		const out = applyListDrag(state, { type: "move", x: -2, y: 2, overIndex: 0, leftWindow: true });
		expect(out.effect).toEqual({ type: "external", id: "note" });
		state = applyListDrag(null, { type: "down", id: "note", index: 0, x: 2, y: 2 }).state;
		const leave = applyListDrag(state, { type: "leave" });
		expect(leave.effect).toEqual({ type: "external", id: "note" });
	});

	it("does not commit a drop on the same row", () => {
		let state = applyListDrag(null, { type: "down", id: "b", index: 1, x: 10, y: 10 }).state;
		state = applyListDrag(state, {
			type: "move",
			x: 10,
			y: 40,
			overIndex: 1,
			leftWindow: false,
		}).state;
		const up = applyListDrag(state, { type: "up" });
		expect(up.effect).toEqual({ type: "none" });
	});
});

describe("item drag payload", () => {
	it("uses the note text for text fields", () => {
		expect(itemExternalDragText(item({ text: "hello" }))).toBe("hello");
	});

	it("uses the URL for links", () => {
		expect(itemExternalDragText(item({ text: "https://welii.com", kind: "link" }))).toBe(
			"https://welii.com",
		);
	});

	it("uses the file name for images", () => {
		expect(itemExternalDragText(item({ text: "/tmp/shots/shot.png", kind: "image" }))).toBe(
			"shot.png",
		);
	});

	it("builds a file URL from an absolute path", () => {
		expect(fileUrlFromPath("/tmp/shots/shot.png")).toBe("file:///tmp/shots/shot.png");
	});
});

describe("extendRangeByIds", () => {
	const ids = ["a", "b", "c", "d", "e"];

	it("starts a range from the cursor and selects the item walked onto", () => {
		expect(extendRangeByIds(ids, null, "b", 1)).toEqual({
			selectedIds: ["b", "c"],
			anchorId: "b",
			cursorId: "c",
		});
	});

	it("unselects items when walking back toward the anchor", () => {
		const down = extendRangeByIds(ids, "b", "c", 1);
		expect(down?.selectedIds).toEqual(["b", "c", "d"]);
		expect(extendRangeByIds(ids, down!.anchorId, down!.cursorId, -1)).toEqual({
			selectedIds: ["b", "c"],
			anchorId: "b",
			cursorId: "c",
		});
	});

	it("grows the range upward from a later anchor", () => {
		expect(extendRangeByIds(ids, null, "c", -1)).toEqual({
			selectedIds: ["b", "c"],
			anchorId: "c",
			cursorId: "b",
		});
	});

	it("clamps at the ends instead of wrapping", () => {
		expect(extendRangeByIds(ids, "a", "a", -1)).toEqual({
			selectedIds: ["a"],
			anchorId: "a",
			cursorId: "a",
		});
		expect(extendRangeByIds(ids, "e", "e", 1)).toEqual({
			selectedIds: ["e"],
			anchorId: "e",
			cursorId: "e",
		});
	});

	it("returns null for an empty list", () => {
		expect(extendRangeByIds([], null, null, 1)).toBeNull();
	});
});

describe("replaceLastToken", () => {
	it("completes a lone @ or # token", () => {
		expect(replaceLastToken("@to", "@todos")).toBe("@todos ");
		expect(replaceLastToken("#ta", "#tag")).toBe("#tag ");
	});

	it("replaces only the last word of a query", () => {
		expect(replaceLastToken("ship @to", "@todos")).toBe("ship @todos ");
	});
});
