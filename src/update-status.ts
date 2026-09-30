export type UpdateErrorPhase = "check" | "install";
export type UpdateErrorKind =
	| "feed-missing"
	| "configuration"
	| "network"
	| "feed"
	| "verification"
	| "unknown";

export type UpdateErrorDescription = {
	kind: UpdateErrorKind;
	message: string;
	detail: string;
};

/** Tauri serializes updater errors as strings, but keep this safe for Error-like objects too. */
export function updateErrorDetail(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message;
		try {
			const serialized = JSON.stringify(error);
			if (serialized && serialized !== "{}") return serialized;
		} catch {
			// Fall through to String below for objects that cannot be serialized.
		}
	}
	return String(error);
}

export function describeUpdateError(
	error: unknown,
	phase: UpdateErrorPhase = "check",
): UpdateErrorDescription {
	const detail = updateErrorDetail(error);
	const normalized = detail.toLowerCase();

	if (
		normalized.includes("updater does not have any endpoints") ||
		normalized.includes("no configured endpoints")
	) {
		return {
			kind: "configuration",
			message: "Update checking is not configured in this build.",
			detail,
		};
	}

	if (
		phase === "check" &&
		(normalized.includes("could not fetch a valid release json") ||
			normalized.includes("release not found") ||
			normalized.includes("404 not found") ||
			normalized.includes("status code 404"))
	) {
		return {
			kind: "feed-missing",
			message: "No published update feed was found. Check again after a release is published.",
			detail,
		};
	}

	if (
		phase === "check" &&
		(normalized.includes("invalid json") ||
			normalized.includes("serialization") ||
			normalized.includes("deserialize") ||
			normalized.includes("missing the `version` field"))
	) {
		return {
			kind: "feed",
			message: "The update feed is invalid. Please install the latest release manually.",
			detail,
		};
	}

	if (
		normalized.includes("signature") ||
		normalized.includes("public key") ||
		normalized.includes("verify")
	) {
		return {
			kind: "verification",
			message: "The update could not be verified. Please install the latest release manually.",
			detail,
		};
	}

	if (
		normalized.includes("network") ||
		normalized.includes("timed out") ||
		normalized.includes("timeout") ||
		normalized.includes("connection") ||
		normalized.includes("connect") ||
		normalized.includes("dns") ||
		normalized.includes("request") ||
		normalized.includes("internet") ||
		normalized.includes("offline")
	) {
		return {
			kind: "network",
			message:
				phase === "check"
					? "Could not reach the update server. Check your internet connection."
					: "Could not download the update. Check your internet connection.",
			detail,
		};
	}

	return {
		kind: "unknown",
		message:
			phase === "check"
				? "Could not check for updates. Try again later."
				: "Could not install the update. Try again later.",
		detail,
	};
}
