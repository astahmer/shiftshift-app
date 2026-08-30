import { describe, expect, it } from "vitest";
import { detectKind, expandTemplate, filterItems, findDuplicate, parseUiCommand, resolveCapture } from "./capture-logic";
import type { Item, Template } from "./store";

function item(overrides: Partial<Item> & Pick<Item, "text">): Item {
	return {
		id: overrides.text,
		kind: "note",
		done: false,
		bookmarked: false,
		rank: 0,
		source_app: null,
		created_at: "2026-01-01T00:00:00Z",
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
		expect(resolveCapture("/unknown foo", templates)).toEqual({ text: "/unknown foo", kind: "note" });
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

	it("recognizes /light and /dark", () => {
		expect(parseUiCommand("/light")).toEqual({ type: "set-theme-mode", mode: "light" });
		expect(parseUiCommand("/dark")).toEqual({ type: "set-theme-mode", mode: "dark" });
	});

	it("recognizes /theme <name>", () => {
		expect(parseUiCommand("/theme dracula")).toEqual({ type: "set-theme", query: "dracula" });
	});

	it("returns null for anything else", () => {
		expect(parseUiCommand("/todo buy milk")).toBeNull();
		expect(parseUiCommand("just text")).toBeNull();
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
