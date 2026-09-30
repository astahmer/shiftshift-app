import { expect, test } from "vitest";
import { startSyncRefresh } from "./sync-refresh";

const wait = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

test("slow sync yields to input, never overlaps, and stops on disposal", async () => {
	let active = 0;
	let maximumActive = 0;
	let refreshes = 0;
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const errors: unknown[] = [];
	const stop = startSyncRefresh({
		intervalMs: 5,
		isVisible: () => true,
		refresh: async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			refreshes += 1;
			await pending;
			active -= 1;
		},
		onError: (error) => errors.push(error),
	});
	try {
		await wait(30);
		expect(refreshes).toBe(1);
		expect(active).toBe(1);
		expect(maximumActive).toBe(1);
		stop();
		release?.();
		await wait(20);
		expect(refreshes).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		stop();
		release?.();
	}
});

test("hidden windows skip I/O; failed sync recovers on next visible poll", async () => {
	let visible = false;
	let attempts = 0;
	const errors: unknown[] = [];
	const stop = startSyncRefresh({
		intervalMs: 5,
		isVisible: () => visible,
		refresh: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporarily unavailable");
		},
		onError: (error) => errors.push(error),
	});
	try {
		await wait(20);
		expect(attempts).toBe(0);
		visible = true;
		await wait(40);
		expect(attempts).toBeGreaterThan(1);
		expect(errors).toHaveLength(1);
	} finally {
		stop();
	}
});

test("disposal while visibility check waits prevents new storage work", async () => {
	let release: ((visible: boolean) => void) | undefined;
	const visibility = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	let reads = 0;
	const stop = startSyncRefresh({
		intervalMs: 5,
		isVisible: () => visibility,
		refresh: async () => {
			reads += 1;
		},
		onError: (error) => {
			throw error;
		},
	});
	try {
		await wait(15);
		stop();
		release?.(true);
		await wait(15);
		expect(reads).toBe(0);
	} finally {
		stop();
		release?.(false);
	}
});
