import { describe, expect, it } from "vitest";
import { describeUpdateError, updateErrorDetail } from "./update-status";

describe("update error feedback", () => {
	it("explains the no-published-release case", () => {
		const result = describeUpdateError("Could not fetch a valid release JSON from the remote");

		expect(result.kind).toBe("feed-missing");
		expect(result.message).toContain("No published update feed");
	});

	it("turns network failures into a useful retry hint", () => {
		const result = describeUpdateError(new Error("request timed out"));

		expect(result.kind).toBe("network");
		expect(result.message).toContain("internet connection");
	});

	it("identifies an updater configuration failure", () => {
		const result = describeUpdateError("Updater does not have any endpoints set.");

		expect(result.kind).toBe("configuration");
		expect(result.message).toContain("not configured");
	});

	it("uses install-specific wording for verification failures", () => {
		const result = describeUpdateError("signature verification failed", "install");

		expect(result.kind).toBe("verification");
		expect(result.message).toContain("could not be verified");
	});

	it("reads message fields from serialized error-like objects", () => {
		expect(updateErrorDetail({ message: "feed unavailable" })).toBe("feed unavailable");
	});
});
