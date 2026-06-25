import { useSyncExternalStore } from "react";
import type { RunTarget } from "../../shared/types";

// The app-wide default for where commands/agents run. Per-command overrides
// fall back to this; agents always use it.
const KEY = "forest-ranger:run-target";

function read(): RunTarget {
	return localStorage.getItem(KEY) === "external" ? "external" : "in-app";
}

let value: RunTarget = read();
const listeners = new Set<() => void>();

export function getDefaultRunTarget(): RunTarget {
	return value;
}

export function setDefaultRunTarget(next: RunTarget) {
	value = next;
	localStorage.setItem(KEY, next);
	for (const fn of listeners) fn();
}

export function useDefaultRunTarget(): RunTarget {
	return useSyncExternalStore(
		(fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		() => value,
	);
}
