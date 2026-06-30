import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
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
		server: { port: 5178, strictPort: true },
	},
});
