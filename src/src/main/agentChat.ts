/**
 * Native chat agent sessions. Unlike the PTY terminals, these drive a coding
 * agent over the Agent Client Protocol (ACP) and emit a normalized
 * {@link AgentChatEvent} stream the view renders as a chat UI.
 *
 * This module owns the generic session lifecycle — buffering, persistence,
 * replay/reattach — while the actual protocol lives behind {@link AgentDriver}
 * (see agentChatAcp.ts). One driver per provider (Claude, Codex, …).
 *
 * Sessions live in the main process so they survive renderer reloads/HMR.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentChatEvent,
	AgentPermissionMode,
	AgentProvider,
	ChatAttachment,
	ElicitationValue,
} from "../shared/types";
import { startAcpDriver } from "./agentChatAcp";

// Persist each chat's event log so the conversation survives a full app restart
// (the in-memory buffer is gone then). The persisted log also carries the ACP
// session id — see acpResumeId below — so the agent can resume where it left off.
const CHAT_DIR = join(
	process.env.FOREST_RANGER_DATA_DIR || join(homedir(), ".forest-ranger"),
	"chats",
);
function chatFile(sessionId: string): string {
	return join(CHAT_DIR, `${sessionId}.json`);
}
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(sessionId: string): void {
	const existing = persistTimers.get(sessionId);
	if (existing) clearTimeout(existing);
	persistTimers.set(
		sessionId,
		setTimeout(() => {
			persistTimers.delete(sessionId);
			const buf = buffers.get(sessionId);
			if (!buf) return;
			try {
				mkdirSync(CHAT_DIR, { recursive: true });
				writeFileSync(chatFile(sessionId), JSON.stringify(buf));
			} catch {
				// best effort — losing persistence shouldn't break the chat
			}
		}, 400),
	);
}
/** Load a persisted log, dropping process-lifecycle events that shouldn't replay. */
function loadPersisted(sessionId: string): AgentChatEvent[] | null {
	try {
		const raw = readFileSync(chatFile(sessionId), "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return (parsed as AgentChatEvent[]).filter((e) => e.type !== "exited");
	} catch {
		return null;
	}
}

/** The ACP session id from the most recent `system` event, if any. */
function lastAcpSessionId(events: AgentChatEvent[] | null): string | null {
	if (!events) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type === "system" && e.sessionId) return e.sessionId;
	}
	return null;
}

/** A running agent session. Backends implement send/stop; the rest is generic. */
export type AgentDriver = {
	/** Send a user turn, with optional file/image attachments. */
	send(text: string, attachments?: ChatAttachment[]): void;
	/** Answer a pending tool-permission request with the chosen option id. */
	respond(requestId: string, optionId: string): void;
	/** Answer a pending structured elicitation. */
	resolveElicit(
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	): void;
	/** Change the client-side permission mode live (no relaunch). */
	setPermissionMode(mode: AgentPermissionMode): void;
	/** Switch the agent's advertised session mode (ACP session/set_mode). */
	setSessionMode(modeId: string): void;
	/** Set a live agent config option (model/mode/effort/…). */
	setConfigOption(configId: string, value: string): void;
	/** Cancel the in-flight turn, keeping the session alive to continue. */
	cancel(): void;
	/** Kill the underlying process. */
	stop(): void;
};

export type Emit = (event: AgentChatEvent) => void;

const sessions = new Map<string, AgentDriver>();

/**
 * Per-session event log, retained while the session is alive so a webview that
 * remounts/reloads (worktree nav, HMR, full reload) can replay the conversation
 * from the still-running main process. Mirrors the terminal scrollback buffer.
 */
const buffers = new Map<string, AgentChatEvent[]>();
const MAX_BUFFER = 5000;

let emitGlobal: ((sessionId: string, event: AgentChatEvent) => void) | null = null;

/** An emitter that records events to the session's buffer, then pushes them out. */
function emitterFor(sessionId: string): Emit {
	return (event) => {
		const buf = buffers.get(sessionId);
		if (buf) {
			buf.push(event);
			if (buf.length > MAX_BUFFER) buf.shift();
			schedulePersist(sessionId);
		}
		emitGlobal?.(sessionId, event);
	};
}

/** Re-push a live session's buffered events to the (re)subscribed view. */
function replay(sessionId: string): void {
	const buf = buffers.get(sessionId);
	if (!buf) return;
	// Bracket the replay with a reset so the view starts from a clean transcript.
	// If two reattaches race and both replay, each reset wipes the prior copy, so
	// the view ends with exactly one — not a duplicated conversation.
	emitGlobal?.(sessionId, { type: "history_reset" });
	for (const event of buf) emitGlobal?.(sessionId, event);
}

/** Wire the main->renderer push callback (set once at startup). */
export function setAgentChatCallback(
	fn: (sessionId: string, event: AgentChatEvent) => void,
) {
	emitGlobal = fn;
}

export type StartOpts = {
	sessionId: string;
	cwd: string;
	/** Which agent backend to launch. */
	provider: AgentProvider;
	resume: boolean;
	permissionMode: AgentPermissionMode;
	model: string | null;
	/** ACP session id to resume the agent's own context from (loadSession). */
	acpResumeId?: string | null;
};

/**
 * Start a chat session, or reattach to a live one. If the session is already
 * running in this process (e.g. the webview reloaded), we replay its buffered
 * history instead of spawning a second process. Always returns true.
 */
export function startSession(opts: StartOpts): boolean {
	if (sessions.has(opts.sessionId)) {
		replay(opts.sessionId);
		return true;
	}
	// New process (e.g. after an app restart): seed the buffer from the persisted
	// log so history shows immediately, and recover the agent's ACP session id so
	// the driver can loadSession and continue where the conversation left off.
	const persisted = opts.resume ? loadPersisted(opts.sessionId) : null;
	buffers.set(opts.sessionId, persisted ?? []);
	if (persisted && persisted.length > 0) replay(opts.sessionId);
	const acpResumeId = opts.resume ? lastAcpSessionId(persisted) : null;
	const emit = emitterFor(opts.sessionId);
	const driver = startAcpDriver({ ...opts, acpResumeId }, emit);
	sessions.set(opts.sessionId, driver);
	return true;
}

/**
 * Switch provider/model/permission mode mid-conversation: stop the current
 * driver and relaunch, resuming the agent's ACP session so context carries over.
 */
export function restart(opts: StartOpts): void {
	sessions.get(opts.sessionId)?.stop();
	const buf = buffers.get(opts.sessionId) ?? [];
	if (!buffers.has(opts.sessionId)) buffers.set(opts.sessionId, buf);
	const acpResumeId = lastAcpSessionId(buf);
	const emit = emitterFor(opts.sessionId);
	const driver = startAcpDriver({ ...opts, resume: true, acpResumeId }, emit);
	sessions.set(opts.sessionId, driver);
}

export function send(sessionId: string, text: string, attachments?: ChatAttachment[]): void {
	const driver = sessions.get(sessionId);
	if (!driver) return;
	// Echo the user turn through the buffer (attachment names only — no data — so
	// the persisted log stays small) so reattach/replay shows it too.
	emitterFor(sessionId)({
		type: "user_text",
		text,
		attachments: attachments?.length
			? attachments.map((a) => ({ name: a.name, isImage: a.mediaType.startsWith("image/") }))
			: undefined,
	});
	driver.send(text, attachments);
}

/** Answer a pending tool-permission request for a session. */
export function respondPermission(sessionId: string, requestId: string, optionId: string): void {
	sessions.get(sessionId)?.respond(requestId, optionId);
}

/** Change a live session's permission mode without relaunching the agent. */
export function setPermissionMode(sessionId: string, mode: AgentPermissionMode): void {
	sessions.get(sessionId)?.setPermissionMode(mode);
}

/** Switch the agent's advertised session mode. */
export function setSessionMode(sessionId: string, modeId: string): void {
	sessions.get(sessionId)?.setSessionMode(modeId);
}

/** Set a live agent config option (model/mode/effort/…). */
export function setConfigOption(sessionId: string, configId: string, value: string): void {
	sessions.get(sessionId)?.setConfigOption(configId, value);
}

/** Answer a pending structured elicitation for a session. */
export function resolveElicit(
	sessionId: string,
	id: string,
	action: "accept" | "decline" | "cancel",
	content?: Record<string, ElicitationValue>,
): void {
	sessions.get(sessionId)?.resolveElicit(id, action, content);
}

/** Cancel the running turn but keep the session alive so the user can continue. */
export function cancel(sessionId: string): void {
	sessions.get(sessionId)?.cancel();
}

/**
 * Stop (kill) a session's agent process. The persisted history is intentionally
 * kept on disk so the chat can be reopened with its full conversation — see
 * startSession's resume path. (Nothing deletes chat history today; that's a
 * deliberate future "delete chat" action, not a side effect of closing.)
 */
export function stop(sessionId: string): void {
	sessions.get(sessionId)?.stop();
	sessions.delete(sessionId);
	buffers.delete(sessionId); // free memory; the on-disk log survives for reopen
}

/** Kill every live chat session — used when the app is quitting. */
export function killAll(): void {
	// Flush any debounced logs synchronously so a quit doesn't lose recent turns.
	try {
		mkdirSync(CHAT_DIR, { recursive: true });
		for (const [sessionId, buf] of buffers) {
			writeFileSync(chatFile(sessionId), JSON.stringify(buf));
		}
	} catch {
		// best effort
	}
	for (const t of persistTimers.values()) clearTimeout(t);
	persistTimers.clear();
	for (const d of sessions.values()) d.stop();
	sessions.clear();
	buffers.clear();
}
