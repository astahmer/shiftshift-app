import { describe, expect, it } from "vitest";
import { detectKind, expandTemplate, resolveCapture } from "./capture-logic";
import type { Template } from "./store";

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
