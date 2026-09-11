import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	main: {
		// The ACP SDK is ESM-only; bundle it into the CJS main output rather than
		// externalizing it (a CJS `require` of an ESM-only package fails at runtime).
		// The Claude adapter stays external — it's spawned as a subprocess, never imported.
		plugins: [externalizeDepsPlugin({ exclude: ["@agentclientprotocol/sdk"] })],
		build: {
			outDir: "out/main",
			lib: { entry: resolve(__dirname, "src/main/index.ts") },
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			outDir: "out/preload",
			lib: { entry: resolve(__dirname, "src/preload/index.ts") },
		},
	},
	renderer: {
		root: "src/mainview",
		plugins: [react()],
		build: {
			outDir: resolve(__dirname, "out/renderer"),
			rollupOptions: { input: resolve(__dirname, "src/mainview/index.html") },
		},
		// Monaco's editor.api graph breaks Vite's dev dep pre-bundling (white screen);
		// serve it as native ESM in dev instead. Dev-only — the production build is
		// unaffected. Its `?worker` imports still resolve.
		optimizeDeps: { exclude: ["monaco-editor"] },
		server: { port: 5178, strictPort: true },
	},
});
