/// <reference types="vite/client" />
/**
 * One-time Monaco setup: wire the language web-workers from the bundled
 * monaco-editor (so it works offline — no CDN). Importing this module runs the
 * setup as a side effect; the editor components import it before they mount.
 *
 * Worker specifiers follow monaco-editor 0.56's `exports` map ("./*" →
 * "./esm/vs/*.js"), i.e. no "esm/vs/" prefix in the import path.
 */
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		if (label === "json") return new jsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new cssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
		if (label === "typescript" || label === "javascript") return new tsWorker();
		return new editorWorker();
	},
};

/** Monaco theme id for the app's resolved light/dark. */
export function monacoTheme(dark: boolean): string {
	return dark ? "vs-dark" : "vs";
}

const LANG_BY_EXT: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
	html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html",
	md: "markdown", mdx: "markdown", py: "python", rb: "ruby", go: "go",
	rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp",
	cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", swift: "swift",
	sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
	graphql: "graphql", gql: "graphql", dockerfile: "dockerfile", tf: "hcl",
};

/** Monaco language id inferred from a path's extension (or filename). */
export function monacoLang(path: string): string {
	const name = path.split("/").pop() ?? path;
	if (name.toLowerCase() === "dockerfile") return "dockerfile";
	const ext = name.split(".").pop()?.toLowerCase();
	return (ext && LANG_BY_EXT[ext]) || "plaintext";
}
