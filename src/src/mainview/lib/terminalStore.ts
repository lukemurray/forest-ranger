import { useSyncExternalStore } from "react";
import type { AgentPermissionMode, AgentProvider } from "../../shared/types";
import {
	type PaneNode,
	insertTabs,
	moveTabToGroup,
	reconcile,
	removeTab,
	setActive as setGroupActive,
	setSizes,
	splitOffTab,
} from "./paneLayout";

export type TermSession = {
	id: string;
	/** Restart-stable identity used to key the pane layout (persisted + reused on
	 *  reopen). Chats default it to their sessionId; terminals get a fresh uuid. */
	paneKey: string;
	worktreeId: string;
	projectId: string;
	title: string;
	/** What renders this session in the dock: a PTY terminal or a native chat. */
	kind: "terminal" | "chat";
	commandId: string | null;
	/** Explicit command to run (e.g. an agent CLI); takes precedence over commandId. */
	command: string | null;
	/** Command to resume the prior conversation when restored ({id} substituted). */
	resumeCommand: string | null;
	/** Generated agent session id (for exact resume), or null. */
	sessionId: string | null;
	/** chat only: resume the prior conversation by sessionId rather than start fresh. */
	resume?: boolean;
	/** chat only: which agent backend drives this chat. */
	provider?: AgentProvider;
	/** chat only: tool-permission mode to launch the agent with. */
	permissionMode?: AgentPermissionMode;
	/** chat only: model alias to launch with (null = agent default). */
	model?: string | null;
	/** chat only: label of the chat agent driving this session. */
	agentLabel?: string;
	/** chat only: a prompt auto-sent once when the session first starts (not persisted). */
	initialPrompt?: string;
	/** Display name on the tab (auto from the first chat message, or renamed). */
	name?: string;
	/** True once the user manually renamed it — don't auto-name over it. */
	renamed?: boolean;
	/** True while the PTY process is alive (cleared on exit). */
	running: boolean;
	/** ms timestamp the session was launched (for elapsed time in Activity). */
	startedAt: number;
};

/** Persisted shape used to restore sessions on next launch. */
export type RestorableSession = Pick<
	TermSession,
	| "paneKey"
	| "worktreeId"
	| "projectId"
	| "title"
	| "kind"
	| "commandId"
	| "command"
	| "resumeCommand"
	| "sessionId"
	| "provider"
	| "permissionMode"
	| "model"
	| "agentLabel"
	| "name"
	| "renamed"
>;

export type DockPosition = "bottom" | "side";

type State = {
	sessions: TermSession[];
	activeId: string | null;
	dock: DockPosition;
	open: boolean;
	/** Per-worktree pane-tiling arrangement (in memory; see paneLayout.ts). */
	layouts: Record<string, PaneNode>;
};

const LAYOUTS_KEY = "forest-ranger:layouts";
const storedLayouts: Record<string, PaneNode> = (() => {
	try {
		const raw = localStorage.getItem(LAYOUTS_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
})();

/** A session's restart-stable pane key (persisted + reused on reopen). */
export function sessionKey(s: Pick<TermSession, "paneKey">): string {
	return s.paneKey;
}

const storedDock = localStorage.getItem("forest-ranger:dock");
let state: State = {
	sessions: [],
	activeId: null,
	dock: storedDock === "side" ? "side" : "bottom",
	open: false,
	layouts: storedLayouts,
};

/** Pane keys of a worktree's sessions, in tab order. */
function sessionKeys(worktreeId: string): string[] {
	return state.sessions.filter((s) => s.worktreeId === worktreeId).map(sessionKey);
}

/** The current (reconciled) layout for a worktree — the same tree the view renders. */
function layoutFor(worktreeId: string): PaneNode {
	return reconcile(state.layouts[worktreeId], sessionKeys(worktreeId));
}

function withLayout(worktreeId: string, next: PaneNode): Record<string, PaneNode> {
	return { ...state.layouts, [worktreeId]: next };
}

// Snapshot of sessions from the previous run, captured before any live changes.
const RESTORE_KEY = "forest-ranger:sessions";
const restorable: RestorableSession[] = (() => {
	try {
		const raw = localStorage.getItem(RESTORE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
})();

// Restorable entries already reopened this run (so a worktree's reopen button
// disappears once used). Keyed by worktree + command.
const consumed = new Set<string>();
// Unique per session: chats are keyed by their (unique) agent session id so
// multiple chats in one worktree don't collide; terminals fall back to command.
const restoreKey = (s: RestorableSession) =>
	`${s.worktreeId}|${s.paneKey ?? s.sessionId ?? s.command ?? s.commandId ?? ""}`;

/** Previous-run sessions not yet reopened (optionally scoped to a worktree). */
export function getRestorableSessions(worktreeId?: string): RestorableSession[] {
	return restorable.filter(
		(s) =>
			!consumed.has(restoreKey(s)) &&
			(worktreeId === undefined || s.worktreeId === worktreeId),
	);
}

function persist() {
	const open: RestorableSession[] = state.sessions.map((s) => ({
		paneKey: s.paneKey,
		worktreeId: s.worktreeId,
		projectId: s.projectId,
		title: s.title,
		kind: s.kind,
		commandId: s.commandId,
		command: s.command,
		resumeCommand: s.resumeCommand,
		sessionId: s.sessionId,
		provider: s.provider,
		permissionMode: s.permissionMode,
		model: s.model,
		agentLabel: s.agentLabel,
		name: s.name,
		renamed: s.renamed,
	}));
	// Keep prior-run sessions we haven't reopened yet (worktrees not visited this
	// run live only in `restorable`, not `state.sessions`) — otherwise the first
	// save of the run would wipe every chat from an unvisited worktree. A session
	// that has been reopened is in `consumed` (and now in `open`), so it's not
	// double-counted; one that was explicitly closed is consumed but dropped from
	// `open`, so it correctly falls out here too.
	const pending = restorable.filter((s) => !consumed.has(restoreKey(s)));
	localStorage.setItem(RESTORE_KEY, JSON.stringify([...open, ...pending]));
	// Persist the tiling arrangement, keyed by restart-stable pane keys (chat
	// sessionIds). Stale terminal keys are reconciled away on reload.
	localStorage.setItem(LAYOUTS_KEY, JSON.stringify(state.layouts));
}

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	persist();
	for (const fn of listeners) fn();
}

/** Relaunch previously-open sessions, resuming the exact conversation by id. */
export function reopenSessions(items: RestorableSession[]) {
	for (const it of items) {
		consumed.add(restoreKey(it));
		if (it.kind === "chat") {
			// Native chat: resume the same agent conversation by its session id.
			openSession({
				paneKey: it.paneKey,
				worktreeId: it.worktreeId,
				projectId: it.projectId,
				title: it.title,
				kind: "chat",
				commandId: null,
				command: null,
				resumeCommand: null,
				sessionId: it.sessionId,
				resume: !!it.sessionId,
				provider: it.provider,
				permissionMode: it.permissionMode,
				model: it.model ?? null,
				agentLabel: it.agentLabel,
				name: it.name,
				renamed: it.renamed,
			});
			continue;
		}
		// Terminal: resume by the stored session id when we have one (deterministic),
		// else fall back to the resume command as-is, else a fresh launch.
		let command = it.command;
		if (it.resumeCommand) {
			command = it.sessionId
				? it.resumeCommand.replace(/\{id\}/g, it.sessionId)
				: it.resumeCommand;
		}
		openSession({
			paneKey: it.paneKey,
			worktreeId: it.worktreeId,
			projectId: it.projectId,
			title: it.title,
			kind: "terminal",
			commandId: it.commandId,
			command,
			resumeCommand: it.resumeCommand,
			sessionId: it.sessionId,
			name: it.name,
			renamed: it.renamed,
		});
	}
}

/** Open a new terminal session (in-app) and focus it. Returns the session id. */
export function openSession(
	s: Omit<TermSession, "id" | "running" | "startedAt" | "paneKey"> & { paneKey?: string },
): string {
	const id = crypto.randomUUID();
	// Stable across restarts: reuse a passed key (reopen), else a chat's sessionId,
	// else a fresh uuid (terminals). This is what the persisted layout keys by.
	const paneKey = s.paneKey ?? (s.kind === "chat" ? s.sessionId ?? crypto.randomUUID() : crypto.randomUUID());
	const session: TermSession = { ...s, id, paneKey, running: true, startedAt: Date.now() };
	const key = sessionKey(session);
	// Add the tab to the currently-focused group (or the first group) and focus it.
	// Insert into the *raw* stored tree, NOT a reconciled one: during a restart the
	// sessions reopen one at a time, so reconciling here against the partial set
	// would prune the not-yet-reopened keys and collapse the saved split. insertTabs
	// is a no-op for an already-placed key, so a restored session keeps its pane;
	// stale keys are cleaned up by the render-time reconcile and explicit close.
	const layout = insertTabs(state.layouts[s.worktreeId], [key], keyOfActive(s.worktreeId));
	set({
		sessions: [...state.sessions, session],
		activeId: id,
		open: true,
		layouts: withLayout(s.worktreeId, layout),
	});
	return id;
}

/** Pane key of the focused session if it's in this worktree (else null). */
function keyOfActive(worktreeId: string): string | null {
	const a = state.sessions.find((x) => x.id === state.activeId && x.worktreeId === worktreeId);
	return a ? sessionKey(a) : null;
}

/** Mark a session's process as exited (keeps the tab; clears the running dot). */
export function markExited(id: string) {
	set({
		sessions: state.sessions.map((s) =>
			s.id === id ? { ...s, running: false } : s,
		),
	});
}

export function closeSession(id: string) {
	const closing = state.sessions.find((s) => s.id === id);
	const sessions = state.sessions.filter((s) => s.id !== id);
	const activeId =
		state.activeId === id ? (sessions.at(-1)?.id ?? null) : state.activeId;
	const layouts = closing
		? withLayout(closing.worktreeId, removeTab(layoutFor(closing.worktreeId), sessionKey(closing)))
		: state.layouts;
	set({ sessions, activeId, open: sessions.length > 0 ? state.open : false, layouts });
}

export function setActiveSession(id: string) {
	const s = state.sessions.find((x) => x.id === id);
	if (!s) return set({ activeId: id });
	const key = sessionKey(s);
	const layout = layoutFor(s.worktreeId);
	const g = findGroupId(layout, key);
	set({
		activeId: id,
		layouts: g ? withLayout(s.worktreeId, setGroupActive(layout, g, key)) : state.layouts,
	});
}

/** Session id for a pane key (activeId is a session id, not a key). */
function idForKey(key: string): string | null {
	return state.sessions.find((s) => sessionKey(s) === key)?.id ?? null;
}

/** Move a tab into another group (or reorder within one) at an optional index. */
export function moveTab(worktreeId: string, tab: string, groupId: string, index?: number) {
	set({
		activeId: idForKey(tab) ?? state.activeId, // dropping a pane focuses it
		layouts: withLayout(worktreeId, moveTabToGroup(layoutFor(worktreeId), tab, groupId, index)),
	});
}

/** Split a group in a direction, peeling `tab` into a new group beside/above it. */
export function splitTab(
	worktreeId: string,
	tab: string,
	groupId: string,
	dir: "row" | "col",
	before: boolean,
) {
	set({
		activeId: idForKey(tab) ?? state.activeId, // the split-off pane becomes focused
		layouts: withLayout(worktreeId, splitOffTab(layoutFor(worktreeId), tab, groupId, dir, before)),
	});
}

/** Persist a split's child sizes after a resizer drag. */
export function resizePane(worktreeId: string, splitId: string, sizes: number[]) {
	set({ layouts: withLayout(worktreeId, setSizes(layoutFor(worktreeId), splitId, sizes)) });
}

/** The id of the group containing `tab`, or null. */
function findGroupId(node: PaneNode, tab: string): string | null {
	if (node.kind === "group") return node.tabs.includes(tab) ? node.id : null;
	for (const c of node.children) {
		const g = findGroupId(c, tab);
		if (g) return g;
	}
	return null;
}

/** Patch fields on a session (e.g. chat model/mode after an in-chat switch). */
export function updateSession(id: string, patch: Partial<TermSession>) {
	set({
		sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
	});
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
