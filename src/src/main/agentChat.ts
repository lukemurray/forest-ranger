/**
 * Native chat agent sessions. Unlike the PTY terminals, these drive a CLI agent
 * in a structured, headless mode (Claude Code's stream-json protocol) and emit a
 * normalized {@link AgentChatEvent} stream the view renders as a chat UI.
 *
 * Sessions live in the main process so they survive renderer reloads/HMR. Only
 * Claude Code is implemented today; other agents slot in behind {@link AgentDriver}.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { AgentChatEvent, AgentPermissionMode, ChatAttachment } from "../shared/types";

// Persist each chat's event log so the conversation survives a full app restart
// (the in-memory buffer is gone then, and `claude --resume` continues a session
// without replaying its transcript). Keyed by the agent session id.
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
function deletePersisted(sessionId: string): void {
	const timer = persistTimers.get(sessionId);
	if (timer) clearTimeout(timer);
	persistTimers.delete(sessionId);
	try {
		rmSync(chatFile(sessionId), { force: true });
	} catch {
		// best effort
	}
}

// A GUI app inherits the minimal launchd PATH; augment it so `claude` resolves
// when launched as a bundled app (mirrors the PATH handling in git.ts).
const AUGMENTED_PATH = [
	process.env.PATH ?? "",
	`${homedir()}/.local/bin`,
	`${homedir()}/.claude/local`,
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
]
	.filter(Boolean)
	.join(":");

/** A running agent session. Backends implement send/stop; the rest is generic. */
type AgentDriver = {
	/** Send a user turn, with optional file/image attachments. */
	send(text: string, attachments?: ChatAttachment[]): void;
	/** Answer a pending tool-permission request. */
	respond(requestId: string, allow: boolean): void;
	/** Kill the underlying process. */
	stop(): void;
};

type Emit = (event: AgentChatEvent) => void;

const sessions = new Map<string, AgentDriver>();

/**
 * Per-session event log, retained while the session is alive so a webview that
 * remounts/reloads (worktree nav, HMR, full reload) can replay the conversation
 * from the still-running main process. Mirrors the terminal scrollback buffer.
 */
const buffers = new Map<string, AgentChatEvent[]>();
const MAX_BUFFER = 5000;

/** Active process per session — used to ignore a superseded process's exit
 * (e.g. after a model/mode switch restarts the agent with `--resume`). */
const procs = new Map<string, ChildProcess>();

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
	for (const event of buf) emitGlobal?.(sessionId, event);
}

/** Wire the bun->webview push callback (set once at startup). */
export function setAgentChatCallback(
	fn: (sessionId: string, event: AgentChatEvent) => void,
) {
	emitGlobal = fn;
}

export type StartOpts = {
	sessionId: string;
	cwd: string;
	resume: boolean;
	permissionMode: AgentPermissionMode;
	model: string | null;
};

/**
 * Start a Claude Code chat session, or reattach to a live one. If the session is
 * already running in this process (e.g. the webview reloaded), we replay its
 * buffered history instead of spawning a second process. Always returns true.
 */
export function startSession(opts: StartOpts): boolean {
	if (sessions.has(opts.sessionId)) {
		replay(opts.sessionId);
		return true;
	}
	// New process (e.g. after an app restart): seed from the persisted log so the
	// conversation history is shown before the live `--resume` continues it.
	const persisted = opts.resume ? loadPersisted(opts.sessionId) : null;
	buffers.set(opts.sessionId, persisted ?? []);
	if (persisted && persisted.length > 0) replay(opts.sessionId);
	const emit = emitterFor(opts.sessionId);
	const driver = startClaudeCode(opts, emit);
	sessions.set(opts.sessionId, driver);
	return true;
}

/**
 * Switch model/permission mode mid-conversation: stop the current process and
 * relaunch with `--resume` so the conversation continues. The buffered history
 * is kept, and the superseded process's exit is ignored (see {@link procs}).
 */
export function restart(opts: StartOpts): void {
	sessions.get(opts.sessionId)?.stop();
	if (!buffers.has(opts.sessionId)) buffers.set(opts.sessionId, []);
	const emit = emitterFor(opts.sessionId);
	const driver = startClaudeCode({ ...opts, resume: true }, emit);
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
export function respondPermission(sessionId: string, requestId: string, allow: boolean): void {
	sessions.get(sessionId)?.respond(requestId, allow);
}

export function stop(sessionId: string): void {
	sessions.get(sessionId)?.stop();
	sessions.delete(sessionId);
	procs.delete(sessionId);
	buffers.delete(sessionId); // explicit close discards the conversation history
	deletePersisted(sessionId);
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
	procs.clear();
	buffers.clear();
}

// --- Claude Code driver (stream-json) ---

/** A user turn in Claude Code's stream-json input format (text + attachments). */
function userMessageLine(text: string, attachments: ChatAttachment[] = []): string {
	const content: unknown[] = [];
	if (text) content.push({ type: "text", text });
	for (const a of attachments) {
		if (a.mediaType.startsWith("image/")) {
			content.push({
				type: "image",
				source: { type: "base64", media_type: a.mediaType, data: a.data },
			});
		} else {
			// Non-image: inline text-like files; note binaries we can't include.
			const decoded = decodeTextFile(a.data);
			content.push({
				type: "text",
				text:
					decoded != null
						? `Attached file \`${a.name}\`:\n\`\`\`\n${decoded}\n\`\`\``
						: `Attached file \`${a.name}\` (binary, not included).`,
			});
		}
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** Decode a base64 file to UTF-8 text, or null if it looks binary. */
function decodeTextFile(b64: string): string | null {
	try {
		const s = Buffer.from(b64, "base64").toString("utf8");
		return s.includes("�") ? null : s;
	} catch {
		return null;
	}
}

function startClaudeCode(opts: StartOpts, emit: Emit): AgentDriver {
	const args = [
		"--print",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode",
		opts.permissionMode,
		// Route tool-permission prompts to us over the control protocol (the
		// `stdio` sentinel + the initialize handshake below) instead of
		// auto-denying tools that need approval.
		"--permission-prompt-tool",
		"stdio",
	];
	if (opts.resume) args.push("--resume", opts.sessionId);
	else args.push("--session-id", opts.sessionId);
	if (opts.model) args.push("--model", opts.model);

	let proc: ChildProcess;
	try {
		proc = spawn("claude", args, {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PATH: AUGMENTED_PATH },
		});
	} catch (err) {
		emit({ type: "error", message: `Failed to launch claude: ${err}` });
		return { send() {}, respond() {}, stop() {} };
	}
	// A spawn failure (e.g. `claude` not on PATH) surfaces asynchronously here.
	proc.on("error", (err) => {
		if (procs.get(opts.sessionId) !== proc) return;
		emit({ type: "error", message: `Failed to launch claude: ${err.message}` });
	});

	procs.set(opts.sessionId, proc);
	// request_id (from a can_use_tool request) -> the tool input, so an "allow"
	// can echo it back as `updatedInput`.
	const pending = new Map<string, unknown>();
	const writeLine = (obj: unknown) => {
		try {
			proc.stdin?.write(`${JSON.stringify(obj)}\n`);
		} catch {
			// stdin closed
		}
	};
	// Declare a permission handler so the CLI forwards `can_use_tool` control
	// requests to us instead of auto-denying tools that need approval.
	writeLine({
		type: "control_request",
		request_id: `init-${crypto.randomUUID()}`,
		request: { subtype: "initialize", hooks: null },
	});
	pumpStdout(proc.stdout, emit, pending);
	captureStderr(proc.stderr);

	proc.on("exit", (code) => {
		// Ignore if a restart (model/mode switch) already replaced this process.
		if (procs.get(opts.sessionId) !== proc) return;
		procs.delete(opts.sessionId);
		sessions.delete(opts.sessionId);
		const exitCode = code ?? 0;
		if (code != null && code !== 0) {
			emit({ type: "error", message: `claude exited with code ${code}` });
		}
		emit({ type: "exited", code: exitCode }); // keep the buffer so reattach shows history
	});

	return {
		send(text: string, attachments: ChatAttachment[] = []) {
			try {
				proc.stdin?.write(userMessageLine(text, attachments));
			} catch (err) {
				emit({ type: "error", message: `Failed to send: ${err}` });
			}
		},
		respond(requestId: string, allow: boolean) {
			const input = pending.get(requestId) ?? {};
			pending.delete(requestId);
			writeLine({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: requestId,
					response: allow
						? { behavior: "allow", updatedInput: input }
						: { behavior: "deny", message: "Denied by the user." },
				},
			});
			emit({ type: "permission_resolved", id: requestId, allow });
		},
		stop() {
			try {
				proc.stdin?.end();
			} catch {
				// already closed
			}
			try {
				proc.kill();
			} catch {
				// already gone
			}
		},
	};
}

/** Read stdout line-by-line, parse each NDJSON record, and emit normalized events. */
function pumpStdout(
	stream: Readable | null,
	emit: Emit,
	pending: Map<string, unknown>,
) {
	if (!stream) return;
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buf += chunk;
		let nl: number;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) handleLine(line, emit, pending);
		}
	});
	stream.on("error", (err) => {
		emit({ type: "error", message: `Stream read error: ${err}` });
	});
}

/** Keep recent stderr so a spawn/auth failure surfaces a useful message. */
function captureStderr(stream: Readable | null) {
	if (!stream) return;
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		const text = chunk.trim();
		if (text) console.error(`[agentChat] ${text}`);
	});
	stream.on("error", () => {
		// stream closed
	});
}

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; is_error?: boolean; content: unknown }
	| { type: string; [k: string]: unknown };

/** Map one Claude Code stream-json record onto our normalized events. */
function handleLine(line: string, emit: Emit, pending: Map<string, unknown>) {
	let msg: Record<string, unknown>;
	try {
		msg = JSON.parse(line);
	} catch {
		return; // not JSON (shouldn't happen in stream-json, but be safe)
	}

	switch (msg.type) {
		case "control_request": {
			// The CLI asks us to approve a tool. Remember the input (to echo on
			// allow) and surface it to the user.
			const req = msg.request as Record<string, unknown> | undefined;
			if (req?.subtype === "can_use_tool") {
				const id = String(msg.request_id);
				pending.set(id, req.input);
				emit({
					type: "permission",
					id,
					toolName: String(req.tool_name ?? "tool"),
					input: req.input,
				});
			}
			return;
		}
		case "control_response":
			return; // ack to our own initialize/control request
		case "system": {
			// init carries the resolved session id + model.
			if (msg.subtype === "init") {
				emit({
					type: "system",
					sessionId: (msg.session_id as string) ?? null,
					model: (msg.model as string) ?? null,
				});
			}
			return;
		}
		case "assistant": {
			const content = blocksOf(msg);
			for (const b of content) {
				if (b.type === "text" && typeof b.text === "string") {
					emit({ type: "assistant_text", text: b.text });
				} else if (b.type === "thinking" && typeof b.thinking === "string") {
					emit({ type: "thinking", text: b.thinking });
				} else if (b.type === "tool_use") {
					emit({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input });
				}
			}
			return;
		}
		case "user": {
			// Tool results come back as a user message with tool_result blocks.
			for (const b of blocksOf(msg)) {
				if (b.type === "tool_result") {
					emit({
						type: "tool_result",
						id: String(b.tool_use_id),
						ok: !b.is_error,
						summary: summarize(b.content),
					});
				}
			}
			return;
		}
		case "result": {
			emit({
				type: "result",
				ok: !msg.is_error,
				durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : null,
			});
			return;
		}
		default:
			// stream_event partials and anything else: ignore for now.
			return;
	}
}

function blocksOf(msg: Record<string, unknown>): ContentBlock[] {
	const message = msg.message as { content?: unknown } | undefined;
	const content = message?.content;
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** Turn arbitrary tool-result content into a short, display-ready string. */
function summarize(content: unknown): string {
	let text: string;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.map((b) =>
				b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
			)
			.join("");
	} else {
		text = JSON.stringify(content);
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 200 ? text.slice(0, 200) + "…" : text;
}
