import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Vitest's default excludes don't cover .direnv — nix/direnv caches a
		// full local copy of this flake's own source under
		// .direnv/flake-inputs/**, which would otherwise be picked up as a
		// second, stale copy of every spec file.
		exclude: ["**/node_modules/**", "**/dist/**", "**/.{git,cache,output,temp,direnv}/**"],
	},
});
