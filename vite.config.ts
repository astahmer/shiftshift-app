import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
	},
	envPrefix: ["VITE_", "TAURI_"],
	build: {
		target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
		minify: !process.env.TAURI_ENV_DEBUG ? "oxc" : false,
		sourcemap: !!process.env.TAURI_ENV_DEBUG,
		rollupOptions: {
			// Three HTML entries: the capture panel (created at launch), plus
			// toast.html / dock.html which Rust lazy-creates on first use.
			input: {
				main: fileURLToPath(new URL("index.html", import.meta.url)),
				toast: fileURLToPath(new URL("toast.html", import.meta.url)),
				dock: fileURLToPath(new URL("dock.html", import.meta.url)),
			},
		},
	},
});
