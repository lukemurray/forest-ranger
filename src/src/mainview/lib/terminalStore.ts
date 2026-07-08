import { useSyncExternalStore } from "react";
import type { AgentPermissionMode, AgentProvider } from "../../shared/types";

export type TermSession = {
	id: string;
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
};

const storedDock = localStorage.getItem("forest-ranger:dock");
let state: State = {
	sessions: [],
	activeId: null,
	dock: storedDock === "side" ? "side" : "bottom",
	open: false,
};

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
	`${s.worktreeId}|${s.sessionId ?? s.command ?? s.commandId ?? ""}`;

/** Previous-run sessions not yet reopened (optionally scoped to a worktree). */
export function getRestorableSessions(worktreeId?: string): RestorableSession[] {
	return restorable.filter(
		(s) =>
			!consumed.has(restoreKey(s)) &&
			(worktreeId === undefined || s.worktreeId === worktreeId),
	);
}

function persist() {
	const data: RestorableSession[] = state.sessions.map((s) => ({
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
	localStorage.setItem(RESTORE_KEY, JSON.stringify(data));
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
export function openSession(s: Omit<TermSession, "id" | "running" | "startedAt">): string {
	const id = crypto.randomUUID();
	set({
		sessions: [...state.sessions, { ...s, id, running: true, startedAt: Date.now() }],
		activeId: id,
		open: true,
	});
	return id;
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
	const sessions = state.sessions.filter((s) => s.id !== id);
	const activeId =
		state.activeId === id ? (sessions.at(-1)?.id ?? null) : state.activeId;
	set({ sessions, activeId, open: sessions.length > 0 ? state.open : false });
}

export function setActiveSession(id: string) {
	set({ activeId: id });
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
