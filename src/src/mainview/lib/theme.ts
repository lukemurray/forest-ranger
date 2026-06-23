import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
type Resolved = "light" | "dark";

const STORAGE_KEY = "forest-ranger:theme";

// localStorage (not SQLite) so the theme can be read & applied synchronously
// before first paint — avoids a flash of the wrong theme on launch.
function readStored(): ThemeMode {
	const v = localStorage.getItem(STORAGE_KEY);
	return v === "light" || v === "dark" || v === "system" ? v : "system";
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(mode: ThemeMode): Resolved {
	if (mode === "system") return darkQuery.matches ? "dark" : "light";
	return mode;
}

let mode: ThemeMode = readStored();
const listeners = new Set<() => void>();

/** Apply the resolved theme to the document root. Safe to call repeatedly. */
export function applyTheme() {
	document.documentElement.dataset.theme = resolve(mode);
}

export function getThemeMode(): ThemeMode {
	return mode;
}

export function setThemeMode(next: ThemeMode) {
	mode = next;
	localStorage.setItem(STORAGE_KEY, next);
	applyTheme();
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

// Re-apply when the OS appearance changes while following the system.
darkQuery.addEventListener("change", () => {
	if (mode === "system") applyTheme();
});

/** React binding for the current theme mode. */
export function useThemeMode(): ThemeMode {
	return useSyncExternalStore(subscribe, getThemeMode);
}
