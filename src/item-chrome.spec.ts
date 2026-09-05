import { describe, expect, it } from "vitest";
import {
	formatHeaderCount,
	hoverActionDefs,
	itemContextEntries,
	nextNotchLoadedCount,
	notchShouldLoadMore,
	stepLoadedSelection,
} from "./item-chrome";
import type { Item } from "./store";

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

describe("header count", () => {
	it("uses a short friendly label for large totals", () => {
		expect(formatHeaderCount(20)).toBe("20");
		expect(formatHeaderCount(99)).toBe("99");
		expect(formatHeaderCount(100)).toBe("100");
		expect(formatHeaderCount(3500)).toBe("3.5k");
		expect(formatHeaderCount(10020)).toBe("10k");
		expect(formatHeaderCount(1_200_000)).toBe("1.2M");
	});
});

describe("hover actions", () => {
	it("matches the main-app action set for notes", () => {
		expect(hoverActionDefs(item({ text: "note" })).map((action) => action.id)).toEqual([
			"preview",
			"bookmark",
			"todo",
			"edit",
			"share",
			"delete",
		]);
	});

	it("omits todo/edit on images", () => {
		expect(hoverActionDefs(item({ text: "/tmp/a.png", kind: "image" })).map((action) => action.id)).toEqual([
			"preview",
			"bookmark",
			"share",
			"delete",
		]);
	});

	it("adds external opening for links", () => {
		expect(hoverActionDefs(item({ text: "https://example.com", kind: "link" })).map((action) => action.id)).toEqual([
			"preview",
			"bookmark",
			"open",
			"todo",
			"edit",
			"share",
			"delete",
		]);
	});
});

describe("context menu", () => {
	it("includes hover actions plus selection commands", () => {
		const ids = itemContextEntries(item({ text: "note" }), { inSelection: false, selectionCount: 0 })
			.filter((entry) => entry.type === "item")
			.map((entry) => entry.id);
		expect(ids).toEqual(["preview", "bookmark", "todo", "edit", "share", "delete", "select", "select_all"]);
	});

	it("adds bulk actions once a selection exists", () => {
		const ids = itemContextEntries(item({ text: "note" }), { inSelection: true, selectionCount: 3 })
			.filter((entry) => entry.type === "item")
			.map((entry) => entry.id);
		expect(ids).toContain("deselect");
		expect(ids).toContain("copy_selection");
		expect(ids).toContain("delete_selection");
		expect(ids).toContain("bookmark_selection");
		expect(ids).toContain("todo_selection");
	});

	it("offers external opening for links", () => {
		const ids = itemContextEntries(item({ text: "https://example.com", kind: "link" }), { inSelection: false, selectionCount: 0 })
			.filter((entry) => entry.type === "item")
			.map((entry) => entry.id);
		expect(ids).toContain("open");
	});
});

describe("notch paging", () => {
	it("grows a page at a time and stops at the total", () => {
		expect(nextNotchLoadedCount(10, 1000)).toBe(50);
		expect(nextNotchLoadedCount(980, 1000)).toBe(1000);
	});

	it("loads more only near the bottom while items remain", () => {
		expect(notchShouldLoadMore(0, 200, 800, 40, 1000)).toBe(false);
		expect(notchShouldLoadMore(600, 200, 800, 40, 1000)).toBe(true);
		expect(notchShouldLoadMore(600, 200, 800, 1000, 1000)).toBe(false);
	});

	it("does not wrap arrow-up onto the last of ten thousand items", () => {
		expect(stepLoadedSelection(0, 40, 10_000, -1)).toEqual({ selected: 39, loaded: 40 });
		expect(stepLoadedSelection(-1, 40, 10_000, -1)).toEqual({ selected: 39, loaded: 40 });
	});

	it("grows a page when arrowing past the loaded window", () => {
		expect(stepLoadedSelection(39, 40, 10_000, 1)).toEqual({ selected: 40, loaded: 80 });
	});

	it("wraps to the start once every item is loaded", () => {
		expect(stepLoadedSelection(99, 100, 100, 1)).toEqual({ selected: 0, loaded: 100 });
	});
});
