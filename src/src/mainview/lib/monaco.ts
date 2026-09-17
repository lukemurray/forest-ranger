/// <reference types="vite/client" />
/**
 * One-time Monaco setup: wire the language web-workers from the bundled
 * monaco-editor (so it works offline — no CDN). Importing this module runs the
 * setup as a side effect; the editor components import it before they mount.
 *
 * Worker specifiers follow monaco-editor 0.56's `exports` map ("./*" →
 * "./esm/vs/*.js"), i.e. no "esm/vs/" prefix in the import path.
 */
import * as monaco from "monaco-editor";
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

// Built once from Monaco's own language registry, so every bundled language
// matches by its registered extensions/filenames — no hand-maintained map.
let byExt: Map<string, string> | null = null;
let byName: Map<string, string> | null = null;
function ensureMaps() {
	if (byExt) return;
	byExt = new Map();
	byName = new Map();
	for (const lang of monaco.languages.getLanguages()) {
		for (const ext of lang.extensions ?? []) byExt.set(ext.toLowerCase(), lang.id); // ".ts"
		for (const fn of lang.filenames ?? []) byName.set(fn.toLowerCase(), lang.id); // "dockerfile"
	}
}

// A few extensions Monaco's registry doesn't cover, mapped to a close language.
const ALIASES: Record<string, string> = {
	".vue": "html",
	".svelte": "html",
	".svg": "xml",
	".mdx": "markdown",
	".jsonc": "json",
	".gql": "graphql",
	".tf": "hcl",
	".tfvars": "hcl",
};

/** Monaco language id for a path, resolved from Monaco's registry (filename first,
 *  then extension), with a small alias fallback; "plaintext" when nothing matches. */
export function monacoLang(path: string): string {
	ensureMaps();
	const name = (path.split("/").pop() ?? path).toLowerCase();
	const byFilename = byName!.get(name);
	if (byFilename) return byFilename;
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot) : "";
	return (ext && (byExt!.get(ext) || ALIASES[ext])) || "plaintext";
}

// Cache of Monaco view state (cursor + scroll) per file/diff tab, so switching
// away from a tab and back lands you where you left off — the tab's editor is
// unmounted while hidden (one live editor per group), so it can't hold this
// itself. View-state objects are tiny; cap the map (LRU) so opening thousands of
// files never grows it unbounded. ponytail: 200-entry LRU, raise if it bites.
const viewStates = new Map<string, unknown>();
const VIEW_STATE_CAP = 200;

export function saveViewState(key: string, s: unknown): void {
	if (!s) return;
	viewStates.delete(key); // re-insert at the end so it's freshest in LRU order
	viewStates.set(key, s);
	if (viewStates.size > VIEW_STATE_CAP) {
		const oldest = viewStates.keys().next().value;
		if (oldest !== undefined) viewStates.delete(oldest);
	}
}

export function getViewState(key: string): unknown {
	return viewStates.get(key);
}
