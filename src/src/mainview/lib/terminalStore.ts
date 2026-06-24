import { useSyncExternalStore } from "react";

export type TermSession = {
	id: string;
	worktreeId: string;
	title: string;
	commandId: string | null;
};

export type DockPosition = "bottom" | "side";

type State = {
	sessions: TermSession[];
	activeId: string | null;
	dock: DockPosition;
	open: boolean;
};

const storedDock = localStorage.getItem("forest-ranger:dock");
let state: State = {
	sessions: [],
	activeId: null,
	dock: storedDock === "side" ? "side" : "bottom",
	open: false,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	for (const fn of listeners) fn();
}

/** Open a new terminal session (in-app) and focus it. Returns the session id. */
export function openSession(s: Omit<TermSession, "id">): string {
	const id = crypto.randomUUID();
	set({
		sessions: [...state.sessions, { ...s, id }],
		activeId: id,
		open: true,
	});
	return id;
}

export function closeSession(id: string) {
	const sessions = state.sessions.filter((s) => s.id !== id);
	const activeId =
		state.activeId === id ? (sessions.at(-1)?.id ?? null) : state.activeId;
	set({ sessions, activeId, open: sessions.length > 0 ? state.open : false });
}

export function setActiveSession(id: string) {
	set({ activeId: id });
}

export function setDock(dock: DockPosition) {
	localStorage.setItem("forest-ranger:dock", dock);
	set({ dock });
}

export function setDockOpen(open: boolean) {
	set({ open });
}

export function useTerminals(): State {
	return useSyncExternalStore(
		(fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		() => state,
	);
}
