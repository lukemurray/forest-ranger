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

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AgentChatEvent,
	AgentPermissionMode,
	AgentProvider,
	ChatAttachment,
	ChatLogMeta,
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
/** The chat's event log: JSON Lines, one event per line, appended as events finalize
 *  (no whole-file rewrites). A crash can only cut the last line, which load skips. */
function chatFile(sessionId: string): string {
	return join(CHAT_DIR, `${sessionId}.jsonl`);
}
/** Pre-JSONL log (one JSON array, rewritten whole). Read to migrate; never written
 *  or deleted by the app — the user can remove them once happy. */
function legacyChatFile(sessionId: string): string {
	return join(CHAT_DIR, `${sessionId}.json`);
}
const mtime = (p: string): number => {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return -1;
	}
};
function chatMetaFile(sessionId: string): string {
	return join(CHAT_DIR, `${sessionId}.meta.json`);
}

// Self-describing header (ChatLogMeta) is persisted alongside each chat so it can
// be listed + reopened later even when the renderer's session list has forgotten it.
// Start-time context per session, folded into the meta sidecar on persist.
const sessionMeta = new Map<
	string,
	{ worktreeId?: string; projectId?: string; provider: AgentProvider; model: string | null }
>();

/** A readable name for a chat: its first user message, truncated. */
function deriveChatName(buf: AgentChatEvent[]): string {
	const first = buf.find((e) => e.type === "user_text");
	const text = first && first.type === "user_text" ? first.text : "";
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return "Chat";
	return line.length > 48 ? `${line.slice(0, 48).trimEnd()}…` : line;
}

// Events that mean something happened in the chat (vs. bookkeeping like modes or
// options, which an agent re-sends whenever it starts).
const WORK_EVENTS = new Set(["user_text", "assistant_text", "tool_use", "tool_result", "result"]);

/**
 * When the chat last had real activity — its newest message/tool event. Not "now":
 * this feeds worktree recency, and merely reopening a chat (restoring tabs after a
 * restart) must not make its worktree look just-used. Logs from before events were
 * timestamped keep their previously saved time.
 */
function lastWorkAt(sessionId: string, buf: AgentChatEvent[]): number {
	for (let i = buf.length - 1; i >= 0; i--) {
		const e = buf[i];
		if (e.ts && WORK_EVENTS.has(e.type)) return e.ts;
	}
	try {
		const prev = JSON.parse(readFileSync(chatMetaFile(sessionId), "utf8")) as ChatLogMeta;
		if (prev.updatedAt) return prev.updatedAt;
	} catch {
		// no saved meta yet — a brand-new chat
	}
	return Date.now();
}

/** Write the `.meta.json` sidecar for a session (files it to its worktree). */
function writeChatMeta(sessionId: string): void {
	const ctx = sessionMeta.get(sessionId);
	const buf = buffers.get(sessionId);
	if (!ctx || !buf) return;
	try {
		mkdirSync(CHAT_DIR, { recursive: true });
		const meta: ChatLogMeta = { sessionId, ...ctx, name: deriveChatName(buf), updatedAt: lastWorkAt(sessionId, buf) };
		writeFileSync(chatMetaFile(sessionId), JSON.stringify(meta));
	} catch {
		// best effort
	}
}

// How many entries at the front of each buffer are already on disk. Those are
// frozen: appendEvent never merges a new chunk into them, so the file only ever
// needs appending.
const written = new Map<string, number>();

/** Append a session's not-yet-written entries to its log. A trailing text/thinking
 *  entry may still be growing (a streaming reply), so it waits for the next flush
 *  unless `all` (closing / quitting). */
function flush(sessionId: string, all: boolean): void {
	const buf = buffers.get(sessionId);
	if (!buf) return;
	const from = written.get(sessionId) ?? 0;
	const tail = buf[buf.length - 1];
	const growing = !all && tail && (tail.type === "assistant_text" || tail.type === "thinking");
	const to = growing ? buf.length - 1 : buf.length;
	if (to <= from) return;
	const lines = buf
		.slice(from, to)
		.filter((e) => !isTransient(e))
		.map((e) => `${JSON.stringify(e)}\n`)
		.join("");
	try {
		mkdirSync(CHAT_DIR, { recursive: true });
		if (lines) appendFileSync(chatFile(sessionId), lines);
		written.set(sessionId, to);
	} catch {
		// best effort — losing persistence shouldn't break the chat
	}
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(sessionId: string): void {
	const existing = persistTimers.get(sessionId);
	if (existing) clearTimeout(existing);
	persistTimers.set(
		sessionId,
		setTimeout(() => {
			persistTimers.delete(sessionId);
			flush(sessionId, false);
			writeChatMeta(sessionId);
		}, 400),
	);
}

/** All persisted chats (newest first), read from the meta sidecars on disk. */
export function listChatLogs(): ChatLogMeta[] {
	let files: string[] = [];
	try {
		files = readdirSync(CHAT_DIR).filter((f) => f.endsWith(".meta.json"));
	} catch {
		return [];
	}
	const out: ChatLogMeta[] = [];
	for (const f of files) {
		try {
			out.push(JSON.parse(readFileSync(join(CHAT_DIR, f), "utf8")) as ChatLogMeta);
		} catch {
			// skip unreadable/partial meta
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
// Transient runtime/lifecycle events, not conversation content: never persisted,
// and dropped on load so an old log written before this rule is cleaned too. This
// is what stops a one-off launch failure ("Failed to launch…", "ACP connection
// closed") from being saved and replayed on every reopen.
function isTransient(e: AgentChatEvent): boolean {
	return e.type === "exited" || e.type === "error";
}

/** Drop transient events and merge streamed chunks. */
function coalesce(events: AgentChatEvent[]): AgentChatEvent[] {
	const out: AgentChatEvent[] = [];
	for (const e of events) if (!isTransient(e)) appendEvent(out, e);
	return out;
}

/**
 * Load a persisted log. Reads the .jsonl, unless a legacy .json is newer (not yet
 * migrated, or written by an older build after migrating) — then that is converted
 * to .jsonl (the .json is left in place) and used.
 */
function loadPersisted(sessionId: string): AgentChatEvent[] | null {
	try {
		const jsonl = chatFile(sessionId);
		const legacy = legacyChatFile(sessionId);
		if (mtime(legacy) > mtime(jsonl)) {
			const parsed = JSON.parse(readFileSync(legacy, "utf8"));
			if (!Array.isArray(parsed)) return null;
			const events = coalesce(parsed as AgentChatEvent[]);
			writeFileSync(jsonl, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
			return events;
		}
		const events: AgentChatEvent[] = [];
		for (const line of readFileSync(jsonl, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as AgentChatEvent);
			} catch {
				// a line cut short by a crash mid-append — skip it
			}
		}
		return coalesce(events);
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
	/** Fork the agent session (at an agent message, else latest); the fork's id. */
	fork(messageId?: string): Promise<string>;
	/** Add a message to the running turn (see agentChatAcp's steer). */
	steer(
		text: string,
		attachments?: ChatAttachment[],
	): Promise<"injected" | "notRunning" | "unsupported" | "failed">;
};

export type Emit = (event: AgentChatEvent) => void;

/** Live agent drivers. A chat can be open (history shown) with no driver: restored
 *  chats start their agent on first use, and idle agents are stopped (see reaper). */
const sessions = new Map<string, AgentDriver>();
/** How to (re)launch each open chat's agent — kept current as settings change. */
const launchOpts = new Map<string, StartOpts>();
/** Last live event or user action per chat, for the idle reaper. */
const lastActivity = new Map<string, number>();
/** Chats with a turn in flight, and open permission/elicitation asks per chat —
 *  neither is ever stopped for being idle. */
const busy = new Set<string>();
const openAsks = new Map<string, number>();
/** Chats that had a driver earlier this run: a relaunch restores their own last
 *  settings (mode/model/…) rather than defaults. */
const hadDriver = new Set<string>();

/**
 * Per-session event log, retained while the session is alive so a webview that
 * remounts/reloads (worktree nav, HMR, full reload) can replay the conversation
 * from the still-running main process. Mirrors the terminal scrollback buffer.
 */
// No event cap: capping dropped the *oldest* events, which silently cut the start
// of long chats from the saved log (incl. the `system` event resume relies on).
// Coalescing streamed chunks (appendEvent) keeps the buffer ~one entry per message
// or tool call instead of one per token burst.
// ponytail: unbounded per session (~1–2MB for the largest chats seen); add a byte cap
// that never drops `system`/user turns if a chat ever gets pathological.
const buffers = new Map<string, AgentChatEvent[]>();

/** Append to a buffer, merging a streamed text/thinking chunk into the previous
 *  one (keeping its ts — when the reply began). Replays identically: the view
 *  merges consecutive chunks the same way. */
function appendEvent(buf: AgentChatEvent[], e: AgentChatEvent, frozen = 0): void {
	const last = buf[buf.length - 1];
	// Usage reports arrive several per turn; only the latest matters.
	if (e.type === "usage" && last?.type === "usage" && buf.length - 1 >= frozen) {
		buf[buf.length - 1] = e;
		return;
	}
	if (
		last &&
		buf.length - 1 >= frozen && // already written to disk → start a new entry
		(e.type === "assistant_text" || e.type === "thinking") &&
		last.type === e.type
	) {
		// The merged entry keeps the newest message id: branching from it includes all of it.
		const messageId = e.type === "assistant_text" ? e.messageId : undefined;
		buf[buf.length - 1] = { ...last, text: last.text + e.text, ...(messageId ? { messageId } : {}) };
	} else {
		buf.push(e);
	}
}

let emitGlobal: ((sessionId: string, event: AgentChatEvent) => void) | null = null;
let statusGlobal: ((sessionId: string, event: AgentChatEvent) => void) | null = null;

/** An emitter that records events to the session's buffer, then pushes them out. */
function emitterFor(sessionId: string): Emit {
	return (event) => {
		// Stamp once here (the single choke point), so the same ts is buffered,
		// persisted, and pushed live — and survives replay on reattach/reload.
		const stamped = { ...event, ts: event.ts ?? Date.now() };
		const buf = buffers.get(sessionId);
		if (buf) {
			appendEvent(buf, stamped, written.get(sessionId) ?? 0);
			schedulePersist(sessionId);
		}
		track(sessionId, stamped);
		emitGlobal?.(sessionId, stamped);
		// Status (working/unread/attention) tracks *live* events only — replay must
		// not re-fire it, or reopening a chat would re-mark old turns.
		statusGlobal?.(sessionId, stamped);
	};
}

/** Bookkeeping for on-demand start and the idle reaper (live events only). */
function track(sessionId: string, e: AgentChatEvent): void {
	lastActivity.set(sessionId, Date.now());
	switch (e.type) {
		case "user_text":
			busy.add(sessionId);
			break;
		case "result":
		case "error":
			busy.delete(sessionId);
			break;
		case "permission":
		case "elicitation":
			openAsks.set(sessionId, (openAsks.get(sessionId) ?? 0) + 1);
			break;
		case "permission_resolved":
		case "elicitation_resolved":
			openAsks.set(sessionId, Math.max(0, (openAsks.get(sessionId) ?? 0) - 1));
			break;
		case "exited":
			// The adapter quit on its own (intentional stops don't emit this). Drop the
			// dead driver so the next message starts a fresh one instead of failing.
			busy.delete(sessionId);
			openAsks.delete(sessionId);
			sessions.delete(sessionId);
			break;
	}
}

/** Wire the live-only status callback (attention/working/unread), never on replay. */
export function setAgentStatusCallback(
	fn: (sessionId: string, event: AgentChatEvent) => void,
) {
	statusGlobal = fn;
}

/** Re-push a live session's buffered events to the (re)subscribed view. */
function replay(sessionId: string): void {
	const buf = buffers.get(sessionId);
	if (!buf) return;
	// One message for the whole history (not one IPC + render per event, which froze
	// the window when a worktree's big chats replayed on switching to it).
	emitGlobal?.(sessionId, { type: "history", events: buf.slice() });
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
	/** Preferred agent mode id, applied when the chat's agent first starts this run. */
	defaultMode?: string | null;
	/** ACP session id to resume the agent's own context from (loadSession). */
	acpResumeId?: string | null;
	/** Where this chat lives — persisted into the log so it can be listed/reopened. */
	worktreeId?: string;
	projectId?: string;
};

/**
 * Open a chat in the view: replay its history, and start its agent only if it's a
 * brand-new chat. A restored chat's agent starts on first use (ensureDriver), so
 * reopening worktrees full of saved chats doesn't spawn an agent per chat.
 * Reattaching to an already-open chat just replays. Always returns true.
 */
export function startSession(opts: StartOpts): boolean {
	// Remember context so the persisted log knows which worktree it belongs to.
	sessionMeta.set(opts.sessionId, {
		worktreeId: opts.worktreeId,
		projectId: opts.projectId,
		provider: opts.provider,
		model: opts.model,
	});
	launchOpts.set(opts.sessionId, { ...launchOpts.get(opts.sessionId), ...opts });
	if (buffers.has(opts.sessionId)) {
		// Already open this run (agent live, idle-stopped, or not started yet).
		writeChatMeta(opts.sessionId); // re-file to this worktree
		replay(opts.sessionId);
		return true;
	}
	// New process (e.g. after an app restart): seed the buffer from the persisted
	// log so history shows immediately, and recover the agent's ACP session id so
	// the driver can loadSession and continue where the conversation left off.
	const persisted = opts.resume ? loadPersisted(opts.sessionId) : null;
	buffers.set(opts.sessionId, persisted ?? []);
	written.set(opts.sessionId, persisted?.length ?? 0);
	// Reopening an existing chat: file it to this worktree right away (don't wait
	// for the first new event), so a recovered orphan stops being an orphan now.
	if (persisted && persisted.length > 0) {
		writeChatMeta(opts.sessionId);
		replay(opts.sessionId);
	}
	// A new chat is about to be used (typed into, or an initial prompt) — start now.
	if (!opts.resume) ensureDriver(opts.sessionId);
	return true;
}

/** The chat's live driver, launching (and resuming) its agent if it has none. */
function ensureDriver(sessionId: string): AgentDriver | null {
	const live = sessions.get(sessionId);
	if (live) return live;
	const opts = launchOpts.get(sessionId);
	const buf = buffers.get(sessionId);
	if (!opts || !buf) return null;
	const acpResumeId = lastAcpSessionId(buf);
	// Relaunching after an idle stop: put back this chat's own last settings once the
	// new agent reports its options (it starts on its defaults).
	let restore: AgentChatEvent | undefined;
	if (hadDriver.has(sessionId)) {
		for (let i = buf.length - 1; i >= 0 && !restore; i--) {
			if (buf[i].type === "configOptions") restore = buf[i];
		}
	}
	const emit = emitterFor(sessionId);
	let configured = false;
	const driver = startAcpDriver({ ...opts, resume: acpResumeId != null, acpResumeId }, (e) => {
		emit(e);
		if (e.type !== "configOptions" || configured) return;
		configured = true;
		if (restore?.type === "configOptions") {
			// Relaunch: this chat's own last settings.
			for (const want of restore.options) {
				const now = e.options.find((o) => o.id === want.id);
				if (now && now.currentValue !== want.currentValue) {
					driver.setConfigOption(want.id, want.currentValue);
				}
			}
		} else if (opts.defaultMode) {
			// First start this run (new chat, or a saved one after an app restart —
			// agents don't keep per-chat mode across restarts): the user's default.
			const mode = e.options.find((o) => o.id === "mode" || o.category === "mode");
			if (
				mode &&
				mode.currentValue !== opts.defaultMode &&
				mode.options.some((o) => o.value === opts.defaultMode)
			) {
				driver.setConfigOption(mode.id, opts.defaultMode);
			}
		}
	});
	sessions.set(sessionId, driver);
	hadDriver.add(sessionId);
	lastActivity.set(sessionId, Date.now());
	return driver;
}

/**
 * Switch provider/model/permission mode mid-conversation: stop the current
 * driver and relaunch, resuming the agent's ACP session so context carries over.
 */
export function restart(opts: StartOpts): void {
	launchOpts.set(opts.sessionId, { ...launchOpts.get(opts.sessionId), ...opts });
	hadDriver.add(opts.sessionId);
	sessions.get(opts.sessionId)?.stop();
	const buf = buffers.get(opts.sessionId) ?? [];
	if (!buffers.has(opts.sessionId)) buffers.set(opts.sessionId, buf);
	const acpResumeId = lastAcpSessionId(buf);
	const emit = emitterFor(opts.sessionId);
	const driver = startAcpDriver({ ...opts, resume: true, acpResumeId }, emit);
	sessions.set(opts.sessionId, driver);
}

export function send(sessionId: string, text: string, attachments?: ChatAttachment[]): void {
	const driver = ensureDriver(sessionId); // first message starts a restored chat's agent
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

/**
 * Steer: put a message into the turn that's running — the agent takes it at its
 * next step and carries on, nothing is cancelled. "sent": nothing was running, so
 * it went as a normal message. "unsupported": the agent can't steer (the view
 * falls back to interrupt-and-send).
 */
export async function steer(
	sessionId: string,
	text: string,
	attachments?: ChatAttachment[],
): Promise<"steered" | "sent" | "unsupported"> {
	const driver = sessions.get(sessionId);
	// Only steer while one of our turns is in flight. (If a turn ends in the gap,
	// Claude hands the message back; Codex would start the turn itself, out of our
	// sight — this check keeps that window tiny.)
	// ponytail: race between this check and the agent finishing remains for Codex.
	if (!driver || !busy.has(sessionId)) {
		send(sessionId, text, attachments);
		return "sent";
	}
	const outcome = await driver.steer(text, attachments);
	if (outcome === "injected") {
		emitterFor(sessionId)({
			type: "user_text",
			text,
			steered: true,
			attachments: attachments?.length
				? attachments.map((a) => ({ name: a.name, isImage: a.mediaType.startsWith("image/") }))
				: undefined,
		});
		return "steered";
	}
	if (outcome === "notRunning") {
		send(sessionId, text, attachments);
		return "sent";
	}
	return "unsupported";
}

/** Answer a pending tool-permission request for a session. */
export function respondPermission(sessionId: string, requestId: string, optionId: string): void {
	sessions.get(sessionId)?.respond(requestId, optionId);
}

/** Change a live session's permission mode without relaunching the agent. */
export function setPermissionMode(sessionId: string, mode: AgentPermissionMode): void {
	const opts = launchOpts.get(sessionId);
	if (opts) opts.permissionMode = mode; // survives a relaunch
	sessions.get(sessionId)?.setPermissionMode(mode);
}

/** Switch the agent's advertised session mode. */
export function setSessionMode(sessionId: string, modeId: string): void {
	ensureDriver(sessionId)?.setSessionMode(modeId);
}

/** Set a live agent config option (model/mode/effort/…). */
export function setConfigOption(sessionId: string, configId: string, value: string): void {
	ensureDriver(sessionId)?.setConfigOption(configId, value);
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
	clearTimeout(persistTimers.get(sessionId));
	persistTimers.delete(sessionId);
	flush(sessionId, true); // write the tail before freeing it
	buffers.delete(sessionId); // free memory; the on-disk log survives for reopen
	written.delete(sessionId);
	forget(sessionId);
}

function forget(sessionId: string): void {
	launchOpts.delete(sessionId);
	lastActivity.delete(sessionId);
	busy.delete(sessionId);
	openAsks.delete(sessionId);
	hadDriver.delete(sessionId);
}

// Stop agents idle this long. Their history stays in memory and on disk, and the
// next message relaunches and resumes them (the agent's own transcript keeps its
// context). Never while a turn is running or a question is waiting on the user.
const IDLE_STOP_MS = 30 * 60_000;
setInterval(() => {
	const cutoff = Date.now() - IDLE_STOP_MS;
	for (const [sessionId, driver] of sessions) {
		if (busy.has(sessionId) || (openAsks.get(sessionId) ?? 0) > 0) continue;
		if ((lastActivity.get(sessionId) ?? 0) > cutoff) continue;
		driver.stop(); // intentional: emits no "exited", so the view stays as-is
		sessions.delete(sessionId);
	}
}, 60_000).unref();

/**
 * Branch a chat: fork its agent session at `messageId` (an agent message; omitted =
 * latest) and create chat `newId` holding the conversation up to that point plus
 * the fork's session id. Like any saved chat, it starts its own agent on first use
 * and resumes the fork — so it has the same context, then diverges.
 */
export async function forkChat(
	sourceId: string,
	newId: string,
	messageId?: string,
): Promise<{ ok: boolean; error?: string }> {
	const buf = buffers.get(sourceId);
	const ctx = sessionMeta.get(sourceId);
	if (!buf || !ctx) return { ok: false, error: "That chat isn't open" };

	// Copy the transcript up to (and including) the chosen message's last chunk.
	let cut = buf.length;
	if (messageId) {
		cut = -1;
		for (let i = buf.length - 1; i >= 0; i--) {
			const e = buf[i];
			if (e.type === "assistant_text" && e.messageId === messageId) {
				cut = i + 1;
				break;
			}
		}
		if (cut === -1) return { ok: false, error: "That message isn't in this chat's history" };
	}

	const driver = ensureDriver(sourceId);
	if (!driver) return { ok: false, error: "Couldn't start the agent" };
	let forkedAcpId: string;
	try {
		forkedAcpId = await driver.fork(messageId);
	} catch (err) {
		return { ok: false, error: `Branch failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	const copied = buf.slice(0, cut).filter((e) => !isTransient(e));
	// A permission/question prompt not answered before the cut would show as live
	// buttons in the branch — drop those.
	const answered = new Set(
		copied.flatMap((e) => (e.type === "permission_resolved" || e.type === "elicitation_resolved" ? [e.id] : [])),
	);
	const seeded = copied.filter(
		(e) => (e.type !== "permission" && e.type !== "elicitation") || answered.has(e.id),
	);
	// Cut mid-turn: close the turn so the branch opens idle, not "working".
	const lastUser = seeded.map((e) => e.type).lastIndexOf("user_text");
	if (lastUser !== -1 && !seeded.slice(lastUser).some((e) => e.type === "result")) {
		seeded.push({ type: "result", ok: true, durationMs: null, ts: Date.now() });
	}
	// Last `system` event = the agent session to resume (see lastAcpSessionId).
	seeded.push({ type: "system", sessionId: forkedAcpId, model: null, ts: Date.now() });

	sessionMeta.set(newId, { ...ctx });
	buffers.set(newId, seeded);
	written.set(newId, 0);
	flush(newId, true);
	writeChatMeta(newId);
	return { ok: true };
}

/** Kill every live chat session — used when the app is quitting. */
export function killAll(): void {
	// Flush any debounced logs synchronously so a quit doesn't lose recent turns.
	for (const sessionId of buffers.keys()) flush(sessionId, true);
	for (const t of persistTimers.values()) clearTimeout(t);
	persistTimers.clear();
	for (const d of sessions.values()) d.stop();
	sessions.clear();
	buffers.clear();
	written.clear();
	for (const id of [...launchOpts.keys()]) forget(id);
}
