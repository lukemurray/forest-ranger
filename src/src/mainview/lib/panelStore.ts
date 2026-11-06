import { useSyncExternalStore } from "react";

/** Which top-level view the right side panel shows. */
export type PanelView = "review" | "files" | "search";

type State = { open: boolean; view: PanelView; changes?: "files" | "commits" };

const OPEN_KEY = "forest-ranger:review-open"; // kept for continuity with the old state
const VIEW_KEY = "forest-ranger:panel-view";

function readView(): PanelView {
	const v = localStorage.getItem(VIEW_KEY);
	return v === "files" || v === "search" ? v : "review";
}

// Each worktree remembers its own panel state; one not seen yet inherits the last used.
const BY_WT_KEY = "forest-ranger:panel-by-worktree";

let state: State = { open: localStorage.getItem(OPEN_KEY) !== "0", view: readView() };
let byWorktree: Record<string, State> = (() => {
	try {
		return JSON.parse(localStorage.getItem(BY_WT_KEY) ?? "{}") ?? {};
	} catch {
		return {};
	}
})();
let current: string | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	if (current) byWorktree = { ...byWorktree, [current]: state };
	try {
		localStorage.setItem(OPEN_KEY, state.open ? "1" : "0");
		localStorage.setItem(VIEW_KEY, state.view);
		localStorage.setItem(BY_WT_KEY, JSON.stringify(byWorktree));
	} catch {
		/* ignore */
	}
	for (const l of listeners) l();
}

/** Switch to a worktree's remembered panel state (called as its view mounts). */
export function setPanelWorktree(id: string | null) {
	if (id === current) return;
	current = id;
	if (id && byWorktree[id]) set(byWorktree[id]);
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
/** Review panel's Files / Commits toggle. */
export function setPanelChanges(changes: "files" | "commits") {
	set({ changes });
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
