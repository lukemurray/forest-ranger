import { useSyncExternalStore } from "react";

/** Which top-level view the right side panel shows. */
export type PanelView = "review" | "files";

type State = { open: boolean; view: PanelView };

const OPEN_KEY = "forest-ranger:review-open"; // kept for continuity with the old state
const VIEW_KEY = "forest-ranger:panel-view";

function readView(): PanelView {
	return localStorage.getItem(VIEW_KEY) === "files" ? "files" : "review";
}

let state: State = { open: localStorage.getItem(OPEN_KEY) !== "0", view: readView() };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	try {
		localStorage.setItem(OPEN_KEY, state.open ? "1" : "0");
		localStorage.setItem(VIEW_KEY, state.view);
	} catch {
		/* ignore */
	}
	for (const l of listeners) l();
}

export function togglePanel() {
	set({ open: !state.open });
}
export function setPanelOpen(open: boolean) {
	set({ open });
}
/** Switch the panel's view and make sure it's visible (⌘1 / ⌘2). */
export function showPanelView(view: PanelView) {
	set({ open: true, view });
}
export function setPanelView(view: PanelView) {
	set({ view });
}

export function usePanel(): State {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => state,
	);
}
