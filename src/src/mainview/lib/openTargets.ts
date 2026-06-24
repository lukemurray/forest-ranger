import { useSyncExternalStore } from "react";
import type { AppId, OpenApp } from "../../shared/types";
import { api } from "../rpc";
import { notify } from "./toast";

// Detection is stable per run — fetch once and share the promise.
let appsPromise: Promise<OpenApp[]> | null = null;
export function loadApps(): Promise<OpenApp[]> {
	if (!appsPromise) appsPromise = api.detectApps({});
	return appsPromise;
}

/** A localStorage-backed "preferred app" with a default-resolution helper. */
function createPreference(key: string, priority: AppId[]) {
	let value: AppId | null = localStorage.getItem(key) as AppId | null;
	const listeners = new Set<() => void>();

	const get = () => value;
	const set = (id: AppId) => {
		value = id;
		localStorage.setItem(key, id);
		for (const fn of listeners) fn();
	};
	const subscribe = (fn: () => void) => {
		listeners.add(fn);
		return () => listeners.delete(fn);
	};
	const use = () => useSyncExternalStore(subscribe, get);

	/** Stored choice if still installed, else the best available default. */
	const resolve = async (): Promise<AppId | null> => {
		const apps = await loadApps();
		const ids = new Set(apps.map((a) => a.id));
		if (value && ids.has(value)) return value;
		const fallback = priority.find((id) => ids.has(id)) ?? null;
		if (!value && fallback) set(fallback);
		return fallback;
	};

	return { get, set, use, resolve };
}

const editor = createPreference("forest-ranger:editor", ["cursor", "vscode", "zed"]);
const terminal = createPreference("forest-ranger:terminal", [
	"ghostty",
	"iterm",
	"warp",
	"terminal",
]);

export const setEditor = editor.set;
export const useEditor = editor.use;
export const setTerminal = terminal.set;
export const useTerminal = terminal.use;

/** Settle default editor/terminal choices on startup. */
export function resolveDefaults() {
	editor.resolve();
	terminal.resolve();
}

export async function listEditors(): Promise<OpenApp[]> {
	return (await loadApps()).filter((a) => a.kind === "editor");
}
export async function listTerminals(): Promise<OpenApp[]> {
	return (await loadApps()).filter((a) => a.kind === "terminal");
}

async function open(path: string, app: AppId | null, missing: string) {
	if (!app) {
		notify(missing, "error");
		return;
	}
	const label = (await loadApps()).find((a) => a.id === app)?.label ?? app;
	const res = await api.openWorktree({ path, app });
	if (!res.ok) {
		notify(`Couldn't open in ${label}${res.error ? `: ${res.error}` : ""}`, "error");
	}
}

export async function openInEditor(path: string) {
	await open(path, await editor.resolve(), "No editor found — install one (e.g. VS Code).");
}

export async function openInTerminal(path: string) {
	await open(path, await terminal.resolve(), "No terminal found.");
}

/** Run a saved project command in a worktree directory (via the chosen terminal). */
export async function runProjectCommand(id: string, cwd: string) {
	const app = await terminal.resolve();
	if (!app) {
		notify("No terminal found.", "error");
		return;
	}
	const res = await api.runCommand({ id, cwd, app });
	if (!res.ok) {
		notify(`Couldn't run command${res.error ? `: ${res.error}` : ""}`, "error");
	}
}
