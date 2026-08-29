import type { Item, Template } from "./store";

const TODO_PREFIX = "/todo ";

export function detectKind(text: string): Item["kind"] {
	if (/^https?:\/\/\S+$/.test(text.trim())) return "link";
	return "note";
}

/** Substitutes `{{name}}` placeholders positionally, in first-appearance order; a repeated name reuses the same arg. */
export function expandTemplate(body: string, args: string[]): string {
	const seen: string[] = [];
	return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name: string) => {
		let index = seen.indexOf(name);
		if (index === -1) {
			seen.push(name);
			index = seen.length - 1;
		}
		return args[index] ?? "";
	});
}

export interface ResolvedCapture {
	text: string;
	kind: Item["kind"];
}

/**
 * Turns what the user typed into what should actually be saved: the
 * built-in `/todo ` prefix, a `/name arg1 arg2` snippet expansion, or the
 * raw text unchanged. `templates` should only be fetched when `raw` starts
 * with "/" — callers decide that to avoid a needless RPC round-trip.
 */
export function resolveCapture(raw: string, templates: Template[]): ResolvedCapture {
	if (raw.startsWith(TODO_PREFIX)) {
		return { text: raw.slice(TODO_PREFIX.length), kind: "todo" };
	}
	if (raw.startsWith("/")) {
		const [name, ...args] = raw.slice(1).split(/\s+/);
		const template = templates.find((t) => t.name === name);
		if (template) {
			const text = expandTemplate(template.body, args);
			return { text, kind: detectKind(text) };
		}
	}
	return { text: raw, kind: detectKind(raw) };
}
