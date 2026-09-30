type SyncRefreshOptions = {
	refresh: () => Promise<void>;
	isVisible: () => boolean | Promise<boolean>;
	intervalMs: number;
	onError: (error: unknown) => void;
};

export const startSyncRefresh = (options: SyncRefreshOptions): (() => void) => {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout>;
	const poll = async (): Promise<void> => {
		try {
			const visible = await options.isVisible();
			if (!stopped && visible) await options.refresh();
		} catch (error) {
			options.onError(error);
		} finally {
			if (!stopped) timer = setTimeout(() => void poll(), options.intervalMs);
		}
	};
	timer = setTimeout(() => void poll(), options.intervalMs);
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
};
