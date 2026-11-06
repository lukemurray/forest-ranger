/**
 * ACP-backed chat driver. Instead of speaking each CLI's bespoke protocol, this
 * talks the Agent Client Protocol (ACP) to an agent adapter subprocess — so the
 * same code drives Claude, Codex, etc. via their adapters. It implements the
 * {@link AgentDriver} contract, slotting in behind the buffer/persist/replay
 * machinery in agentChat.ts.
 *
 * Each provider maps to an adapter that reuses the user's existing login for that
 * tool (no API keys): Claude via `@agentclientprotocol/claude-agent-acp` (drives
 * the local `claude` CLI), Codex via `@agentclientprotocol/codex-acp` (bundles
 * `@openai/codex`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
// The full v1 surface (`/unstable` = stable + unstable features), matching what the
// pre-2.0 default import exposed: we use elicitation and session config options.
import {
	client as acpClient,
	CreateElicitationRequest,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type AgentNotificationParamsByMethod,
	type AgentRequestMethod,
	type AgentRequestParamsByMethod,
	type AgentRequestResponsesByMethod,
	type ClientContext,
	type CreateElicitationResponse,
	type RequestPermissionResponse,
	type ClientNotificationHandlersByMethod,
	type ClientNotificationMethod,
	type ClientRequestHandlersByMethod,
	type ClientRequestMethod,
} from "@agentclientprotocol/sdk/unstable";

/** Params of a client-side ACP request / notification, from the SDK's handler maps. */
type ReqParams<M extends ClientRequestMethod> = Parameters<ClientRequestHandlersByMethod[M]>[0]["params"];
type NoteParams<M extends ClientNotificationMethod> = Parameters<
	ClientNotificationHandlersByMethod[M]
>[0]["params"];

/**
 * The agent-side calls we make, as named methods over the SDK 2 peer context
 * (`request` / `notify` by method constant) — the shape the old
 * ClientSideConnection had, so the session code below reads the same.
 */
function agentCalls(agent: ClientContext) {
	const call =
		<M extends AgentRequestMethod>(method: M) =>
		(params: AgentRequestParamsByMethod[M]): Promise<AgentRequestResponsesByMethod[M]> =>
			agent.request(method, params);
	return {
		initialize: call(methods.agent.initialize),
		newSession: call(methods.agent.session.new),
		loadSession: call(methods.agent.session.load),
		prompt: call(methods.agent.session.prompt),
		setSessionMode: call(methods.agent.session.setMode),
		setSessionConfigOption: call(methods.agent.session.setConfigOption),
		fork: call(methods.agent.session.fork),
		// `_session/steering` (extension, both adapters): add a message to the running
		// turn — the agent picks it up at its next step — instead of queueing a prompt.
		steer: (params: { sessionId: string; prompt: unknown[]; _meta?: unknown }) =>
			agent.request<{ outcome?: string }>("_session/steering", params),
		cancel: (params: AgentNotificationParamsByMethod[typeof methods.agent.session.cancel]) =>
			agent.notify(methods.agent.session.cancel, params),
	};
}
import type {
	AgentPermissionMode,
	AgentProvider,
	ChatAttachment,
	ChatDiff,
	ElicitationField,
	ElicitationValue,
} from "../shared/types";
import type { AgentDriver, Emit, StartOpts } from "./agentChat";

// A GUI app inherits the minimal launchd PATH; augment it so the adapters and the
// CLIs they spawn resolve when launched as a bundled app.
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

/** Per-provider adapter wiring: which stdio entrypoint to spawn and its env. */
type ProviderSpec = {
	/** Resolve the adapter's stdio entrypoint (external — run as a subprocess). */
	entry: () => string;
	/** Extra env carrying model/mode config for that adapter. */
	env: (opts: StartOpts) => Record<string, string>;
};

/** Map our permission modes onto Codex's initial agent mode. */
function codexMode(mode: AgentPermissionMode): string {
	if (mode === "bypassPermissions") return "agent-full-access";
	if (mode === "plan") return "read-only";
	return "agent";
}

const PROVIDERS: Record<AgentProvider, ProviderSpec> = {
	claude: {
		entry: () =>
			require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"),
		env: (opts) => {
			const env: Record<string, string> = {};
			if (opts.model) env.ANTHROPIC_MODEL = opts.model;
			return env;
		},
	},
	codex: {
		entry: () => require.resolve("@agentclientprotocol/codex-acp/dist/index.js"),
		env: (opts) => {
			const env: Record<string, string> = {
				INITIAL_AGENT_MODE: codexMode(opts.permissionMode),
			};
			if (opts.model) env.CODEX_CONFIG = JSON.stringify({ model: opts.model });
			return env;
		},
	},
};

/** Build the user turn's ACP content blocks (text + attachments). */
function promptBlocks(text: string, attachments: ChatAttachment[]) {
	const blocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	> = [];
	if (text) blocks.push({ type: "text", text });
	for (const a of attachments) {
		if (a.mediaType.startsWith("image/")) {
			blocks.push({ type: "image", data: a.data, mimeType: a.mediaType });
		} else {
			const decoded = decodeTextFile(a.data);
			blocks.push({
				type: "text",
				text:
					decoded != null
						? `Attached file \`${a.name}\`:\n\`\`\`\n${decoded}\n\`\`\``
						: `Attached file \`${a.name}\` (binary, not included).`,
			});
		}
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "" });
	return blocks;
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

/**
 * Flatten ACP tool-call content into display text, preserving newlines so the
 * UI can render it as Markdown. Capped so a huge output can't bloat the
 * persisted buffer.
 */
function toolContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text = content
		.map((c) => {
			if (c && typeof c === "object") {
				const block = c as { content?: { text?: unknown }; text?: unknown };
				if (block.content && typeof block.content.text === "string") {
					return block.content.text;
				}
				if (typeof block.text === "string") return block.text;
			}
			return "";
		})
		.join("\n")
		.trim();
	return text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
}

/** Pull structured file edits out of ACP tool content (`type: "diff"` blocks), so
 *  the UI can render a real diff instead of the flattened text. */
function toolContentDiffs(content: unknown): ChatDiff[] {
	if (!Array.isArray(content)) return [];
	const out: ChatDiff[] = [];
	for (const c of content) {
		if (c && typeof c === "object") {
			const b = c as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown };
			if (b.type === "diff" && typeof b.path === "string" && typeof b.newText === "string") {
				out.push({
					path: b.path,
					oldText: typeof b.oldText === "string" ? b.oldText : null,
					newText: b.newText,
				});
			}
		}
	}
	return out;
}

/** Turn ACP `enum` / `oneOf` into {value,label} options. */
function enumOptions(
	enumValues?: string[] | null,
	oneOf?: Array<{ const: string; title: string }> | null,
): { value: string; label: string }[] {
	if (oneOf?.length) return oneOf.map((o) => ({ value: o.const, label: o.title }));
	if (enumValues?.length) return enumValues.map((v) => ({ value: v, label: v }));
	return [];
}

/** Normalize an ACP elicitation form schema into flat fields the UI can render. */
function normalizeSchema(schema: unknown): ElicitationField[] {
	const s = (schema ?? {}) as {
		properties?: Record<string, Record<string, unknown>>;
		required?: string[];
	};
	const required = new Set(s.required ?? []);
	return Object.entries(s.properties ?? {}).map(([key, p]) => {
		const base = {
			key,
			label: (p.title as string) || key,
			description: (p.description as string) ?? undefined,
			required: required.has(key),
			default: p.default as ElicitationField["default"],
		};
		switch (p.type) {
			case "boolean":
				return { ...base, input: "boolean" as const };
			case "number":
				return { ...base, input: "number" as const };
			case "integer":
				return { ...base, input: "integer" as const };
			case "array": {
				const items = (p.items ?? {}) as {
					enum?: string[];
					oneOf?: { const: string; title: string }[];
				};
				return {
					...base,
					input: "multiselect" as const,
					options: enumOptions(items.enum, items.oneOf),
				};
			}
			default: {
				const opts = enumOptions(
					p.enum as string[] | undefined,
					p.oneOf as { const: string; title: string }[] | undefined,
				);
				return opts.length
					? { ...base, input: "select" as const, options: opts }
					: { ...base, input: "text" as const };
			}
		}
	});
}

/** Map a user's elicitation answer onto the ACP response shape. */
function elicitResponse(
	action: "accept" | "decline" | "cancel",
	content?: Record<string, ElicitationValue>,
) {
	if (action === "accept") return { action: "accept" as const, content: content ?? {} };
	if (action === "decline") return { action: "decline" as const };
	return { action: "cancel" as const };
}

export function startAcpDriver(opts: StartOpts, emit: Emit): AgentDriver {
	const spec = PROVIDERS[opts.provider];
	let proc: ChildProcess | null = null;
	let conn: ReturnType<typeof agentCalls> | null = null;
	let sessionId: string | null = null;
	let closed = false;
	let canSteer = false;
	// Mutable so the UI can change it live (client-side enforcement) without a relaunch.
	let permissionMode = opts.permissionMode;
	// Agent-advertised session modes, retained so current_mode_update (which carries
	// only the new id) can re-emit the full list.
	let availableModes: { id: string; name: string; description?: string }[] = [];
	// While true, swallow session updates (used during loadSession's history
	// replay so we don't duplicate the buffer we already restored from disk).
	let suppressReplay = false;
	// Pending permission requests surfaced to the UI, keyed by id. `labels` maps
	// optionId → human label so a resolved request can show what was chosen.
	const pendingPerms = new Map<
		string,
		{ resolve: (optionId: string | null) => void; labels: Record<string, string> }
	>();
	// Resolvers for structured elicitations awaiting the user's answer, keyed by id.
	const pendingElicits = new Map<
		string,
		(action: "accept" | "decline" | "cancel", content?: Record<string, ElicitationValue>) => void
	>();

	// The connection/session come up asynchronously; queue sends until ready.
	let readyResolve: () => void;
	const ready = new Promise<void>((r) => {
		readyResolve = r;
	});

	// Normalize the agent's ACP config options (model/mode/effort/…) for the UI.
	// Only "select" options are surfaced (the Claude adapter uses select for all).
	type AcpConfigOption = {
		type?: string;
		id: string;
		name: string;
		category?: string | null;
		currentValue: string;
		options: { value: string; name: string; description?: string | null }[];
	};
	const emitConfig = (opts: readonly unknown[] | null | undefined) => {
		if (!opts) return;
		const mapped = (opts as AcpConfigOption[])
			.filter((o) => o.type === "select")
			.map((o) => ({
				id: o.id,
				name: o.name,
				category: o.category ?? undefined,
				currentValue: o.currentValue,
				options: o.options.map((v) => ({
					value: v.value,
					label: v.name,
					description: v.description ?? undefined,
				})),
			}));
		emit({ type: "configOptions", options: mapped });
	};

	// Confine client-mediated file I/O to the session's worktree — the agent has
	// shell access anyway, but our fs proxy shouldn't reach outside the cwd.
	const inCwd = (p: string): string => {
		const abs = resolve(p);
		const root = resolve(opts.cwd);
		if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path outside worktree: ${p}`);
		return abs;
	};

	const clientImpl = {
		// Client-mediated reads/writes (fs capability). The agent uses these to edit
		// files, which surface as structured tool calls with diff content.
		async readTextFile(params: ReqParams<typeof methods.client.fs.readTextFile>) {
			const text = readFileSync(inCwd(params.path), "utf8");
			if (params.line == null && params.limit == null) return { content: text };
			const lines = text.split("\n");
			const start = params.line ? Math.max(0, params.line - 1) : 0;
			const end = params.limit != null ? start + params.limit : lines.length;
			return { content: lines.slice(start, end).join("\n") };
		},
		async writeTextFile(params: ReqParams<typeof methods.client.fs.writeTextFile>) {
			writeFileSync(inCwd(params.path), params.content);
			return {};
		},
		async requestPermission(
			params: ReqParams<typeof methods.client.session.requestPermission>,
		): Promise<RequestPermissionResponse> {
			const options = params.options ?? [];
			const allow =
				options.find((o) => o.kind === "allow_once") ??
				options.find((o) => o.kind === "allow_always");

			// Auto-permission modes resolve without bothering the user.
			const autoAllow =
				permissionMode === "bypassPermissions" ||
				(permissionMode === "acceptEdits" &&
					!!params.toolCall?.kind &&
					["edit", "delete", "move"].includes(params.toolCall.kind));
			if (autoAllow && allow) {
				return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
			}

			// Surface every option the agent offered (Yes / Yes & always / No / …) and
			// resolve with whichever the user picks.
			const id = String(params.toolCall?.toolCallId ?? crypto.randomUUID());
			emit({
				type: "permission",
				id,
				toolName: params.toolCall?.title ?? "tool",
				input: params.toolCall?.rawInput,
				options: options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
			});
			return new Promise((resolve) => {
				pendingPerms.set(id, {
					resolve: (optionId) =>
						resolve(
							optionId
								? { outcome: { outcome: "selected" as const, optionId } }
								: { outcome: { outcome: "cancelled" as const } },
						),
					labels: Object.fromEntries(options.map((o) => [o.optionId, o.name])),
				});
			});
		},

		async sessionUpdate(params: NoteParams<typeof methods.client.session.update>) {
			if (suppressReplay) return;
			const u = params.update;
			switch (u.sessionUpdate) {
				case "agent_message_chunk":
					if (u.content.type === "text") {
						// Keep the message id: it's the point a chat can be branched from.
						emit({
							type: "assistant_text",
							text: u.content.text,
							...(u.messageId ? { messageId: u.messageId } : {}),
						});
					}
					break;
				case "agent_thought_chunk":
					if (u.content.type === "text") {
						emit({ type: "thinking", text: u.content.text });
					}
					break;
				case "tool_call": {
					const diffs = toolContentDiffs(u.content);
					emit({
						type: "tool_use",
						id: String(u.toolCallId),
						name: u.title || u.kind || "tool",
						input: u.rawInput,
						diffs: diffs.length ? diffs : undefined,
					});
					break;
				}
				case "tool_call_update":
					if (u.status === "completed" || u.status === "failed") {
						const diffs = toolContentDiffs(u.content);
						emit({
							type: "tool_result",
							id: String(u.toolCallId),
							ok: u.status === "completed",
							summary: toolContentText(u.content),
							diffs: diffs.length ? diffs : undefined,
						});
					}
					break;
				case "usage_update":
					emit({
						type: "usage",
						used: u.used,
						size: u.size,
						...(u.cost ? { cost: { amount: u.cost.amount, currency: u.cost.currency } } : {}),
					});
					break;
				case "plan":
					emit({
						type: "plan",
						entries: (u.entries ?? []).map((e) => ({ content: e.content, status: e.status })),
					});
					break;
				case "available_commands_update":
					emit({
						type: "commands",
						commands: (u.availableCommands ?? []).map((c) => ({
							name: c.name,
							description: c.description,
						})),
					});
					break;
				case "current_mode_update":
					emit({ type: "modes", current: u.currentModeId, available: availableModes });
					break;
				case "config_option_update":
					emitConfig(u.configOptions);
					break;
				default:
					// user_message_chunk / config / usage: ignored for now.
					break;
			}
		},

		// The agent asks the user for structured input (a form) or to visit a URL.
		// We surface it and resolve when the user answers (or the agent completes it).
		async createElicitation(
			params: ReqParams<typeof methods.client.elicitation.create>,
		): Promise<CreateElicitationResponse> {
			const message = params.message;
			// The request is a union with a catch-all `mode` string, so plain discriminant
			// narrowing doesn't work — use the SDK's shipped type guards.
			if (CreateElicitationRequest.isUrl(params)) {
				const id = params.elicitationId;
				emit({ type: "elicitation", id, mode: "url", message, fields: [], url: params.url });
				return new Promise((resolve) => {
					pendingElicits.set(id, (action, content) =>
						resolve(elicitResponse(action, content)),
					);
				});
			}
			const id = crypto.randomUUID();
			emit({
				type: "elicitation",
				id,
				mode: "form",
				message,
				fields: CreateElicitationRequest.isForm(params)
					? normalizeSchema(params.requestedSchema)
					: [],
			});
			return new Promise((resolve) => {
				pendingElicits.set(id, (action, content) =>
					resolve(elicitResponse(action, content)),
				);
			});
		},

		// URL-based elicitation finished on the agent's side — resolve if still open.
		async completeElicitation(params: NoteParams<typeof methods.client.elicitation.complete>) {
			const id = (params as { elicitationId?: string }).elicitationId;
			if (id) {
				const r = pendingElicits.get(id);
				if (r) {
					pendingElicits.delete(id);
					r("accept");
				}
				emit({ type: "elicitation_resolved", id });
			}
		},
	};

	async function init(): Promise<void> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: AUGMENTED_PATH,
			// Run the adapter's Node script under Electron acting as plain Node,
			// so we don't depend on a system `node` being installed.
			ELECTRON_RUN_AS_NODE: "1",
			...spec.env(opts),
		};

		proc = spawn(process.execPath, [spec.entry()], {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		proc.on("error", (err) => {
			if (closed) return;
			emit({ type: "error", message: `Failed to launch ${opts.provider} adapter: ${err.message}` });
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			const t = chunk.trim();
			if (t) console.error(`[agentChatAcp:${opts.provider}] ${t}`);
		});
		proc.on("exit", (code) => {
			if (closed) return;
			const exitCode = code ?? 0;
			if (code != null && code !== 0) {
				emit({ type: "error", message: `${opts.provider} adapter exited with code ${code}` });
			}
			emit({ type: "exited", code: exitCode });
		});

		const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
		const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
		// SDK 2 app API: register our handlers, connect over the adapter's stdio.
		const app = acpClient()
			.onRequest(methods.client.fs.readTextFile, ({ params }) => clientImpl.readTextFile(params))
			.onRequest(methods.client.fs.writeTextFile, ({ params }) => clientImpl.writeTextFile(params))
			.onRequest(methods.client.session.requestPermission, ({ params }) =>
				clientImpl.requestPermission(params),
			)
			.onRequest(methods.client.elicitation.create, ({ params }) =>
				clientImpl.createElicitation(params),
			)
			.onNotification(methods.client.session.update, ({ params }) => clientImpl.sessionUpdate(params))
			.onNotification(methods.client.elicitation.complete, ({ params }) =>
				clientImpl.completeElicitation(params),
			);
		conn = agentCalls(app.connect(ndJsonStream(input, output)).agent);

		const initRes = await conn.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				// Advertise client-mediated file I/O so the agent edits through the ACP
				// fs path (structured, with diff content we can render) instead of falling
				// back to shell writes. Handlers below proxy to the worktree on disk.
				fs: { readTextFile: true, writeTextFile: true },
				// Advertise structured elicitation so the agent can ask the user for
				// form input or send them to a URL.
				elicitation: { form: {}, url: {} },
			},
		});

		// Agents advertise mid-turn steering in initialize's `_meta`.
		canSteer = !!(initRes as { _meta?: { steering?: { supported?: boolean } } })._meta?.steering?.supported;

		// Resume the agent's own context when we can (loadSession replays history
		// silently so it doesn't duplicate the buffer we already restored).
		type ModeState = {
			currentModeId: string;
			availableModes: { id: string; name: string; description?: string | null }[];
		};
		const emitModes = (modes: ModeState | null | undefined) => {
			if (!modes) return;
			availableModes = modes.availableModes.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? undefined,
			}));
			emit({ type: "modes", current: modes.currentModeId, available: availableModes });
		};

		const canLoad = !!initRes.agentCapabilities?.loadSession;
		if (opts.resume && opts.acpResumeId && canLoad) {
			try {
				suppressReplay = true;
				const res = await conn.loadSession({
					sessionId: opts.acpResumeId,
					cwd: opts.cwd,
					mcpServers: [],
				});
				sessionId = opts.acpResumeId;
				emitModes(res?.modes);
				emitConfig(res?.configOptions);
			} catch {
				sessionId = null; // stale/expired — fall through to a fresh session
			} finally {
				suppressReplay = false;
			}
		}
		if (!sessionId) {
			const res = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
			sessionId = res.sessionId;
			emitModes(res.modes);
			emitConfig(res.configOptions);
		}
		// ACP doesn't report a resolved model id, and the picker already shows the
		// chosen model — so don't emit an alias here (it would surface as a bogus
		// "resolved model" chip next to the picker).
		emit({ type: "system", sessionId, model: null });
		readyResolve();
	}

	init().catch((err) => {
		emit({ type: "error", message: `ACP init failed: ${err?.message ?? err}` });
		readyResolve();
	});

	return {
		send(text: string, attachments: ChatAttachment[] = []) {
			ready
				.then(() => {
					// Intentional teardown (stop/restart) — the view resets separately.
					if (closed) return;
					// The view flipped to "working" on the echoed user message, so it needs
					// a turn-end event no matter what. If we can't even issue the prompt
					// (connection never came up / dropped), emit a terminal result so the
					// composer doesn't get stuck showing Stop with nothing running.
					if (!conn || !sessionId) {
						emit({ type: "error", message: "Chat isn't connected — send failed." });
						return;
					}
					return conn
						.prompt({ sessionId, prompt: promptBlocks(text, attachments) })
						.then((res) => {
							emit({
								type: "result",
								ok: res.stopReason !== "refusal",
								durationMs: null,
							});
						});
				})
				.catch((err) => {
					// A restart/stop tears down the connection intentionally — the
					// in-flight prompt rejects, but that's not a failure to report.
					if (closed) return;
					emit({ type: "error", message: `Send failed: ${err?.message ?? err}` });
				});
		},
		respond(requestId: string, optionId: string) {
			const p = pendingPerms.get(requestId);
			if (!p) return;
			pendingPerms.delete(requestId);
			p.resolve(optionId);
			emit({ type: "permission_resolved", id: requestId, label: p.labels[optionId] ?? optionId });
		},
		resolveElicit(id, action, content) {
			const r = pendingElicits.get(id);
			if (r) {
				pendingElicits.delete(id);
				r(action, content);
			}
			emit({ type: "elicitation_resolved", id });
		},
		setPermissionMode(mode) {
			permissionMode = mode;
		},
		/**
		 * Add a message to the running turn (the agent takes it at its next step,
		 * keeping its work). "notRunning": no turn was in flight — send it normally.
		 * "unsupported": this agent can't steer — the caller falls back to interrupt.
		 */
		steer(text: string, attachments: ChatAttachment[] = []) {
			return ready.then(async (): Promise<"injected" | "notRunning" | "unsupported" | "failed"> => {
				if (closed || !conn || !sessionId) return "failed";
				if (!canSteer) return "unsupported";
				try {
					const res = await conn.steer({
						sessionId,
						prompt: promptBlocks(text, attachments),
						// If the turn already ended, hand it back so we send it as a normal
						// prompt (and see that turn's end). Claude honours this; Codex starts
						// the turn itself — the caller only steers while a turn is running.
						_meta: { steering: { idleBehavior: "promptRequired" } },
					});
					if (res.outcome === "injected" || res.outcome === "startedNewTurn") return "injected";
					if (res.outcome === "promptRequired") return "notRunning";
					return "failed";
				} catch {
					return "failed";
				}
			});
		},
		/**
		 * Fork this agent session into a new one — at an agent message when given
		 * (that message and everything before it), else at its latest state. The fork
		 * point is JetBrains AIR's `_meta` extension, which both the Claude and Codex
		 * adapters read; plain ACP `session/fork` only copies the whole session.
		 */
		fork(messageId?: string): Promise<string> {
			return ready.then(async () => {
				if (closed || !conn || !sessionId) throw new Error("Chat isn't connected");
				const res = await conn.fork({
					sessionId,
					cwd: opts.cwd,
					mcpServers: [],
					...(messageId ? { _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } } } : {}),
				});
				return res.sessionId;
			});
		},
		// Like send, these wait for the session: an agent started on demand by this
		// very change isn't connected yet.
		setSessionMode(modeId) {
			ready.then(() => {
				if (!closed && conn && sessionId) conn.setSessionMode({ sessionId, modeId }).catch(() => {});
			});
		},
		setConfigOption(configId, value) {
			ready.then(() => {
				if (closed || !conn || !sessionId) return;
				// The response returns the full, refreshed option set (options can depend
				// on each other — e.g. fast-mode availability changes with the model), so
				// re-emit it as the authoritative state.
				conn
					.setSessionConfigOption({ sessionId, configId, value })
					.then((res) => emitConfig((res as { configOptions?: unknown[] })?.configOptions))
					.catch(() => {});
			});
		},
		cancel() {
			// Cancel the current turn but keep the process/session alive so the user
			// can keep chatting. The agent responds to the pending prompt with a
			// "cancelled" stop reason, which resolves the turn normally.
			if (conn && sessionId) conn.cancel({ sessionId }).catch(() => {});
			// ACP requires the client to answer every open permission request with
			// "cancelled" (and close open forms) on cancel — otherwise an agent that was
			// waiting on one never finishes the cancelled turn, and a steer never sends.
			for (const [id, p] of pendingPerms) {
				p.resolve("");
				emit({ type: "permission_resolved", id, label: "Cancelled" });
			}
			pendingPerms.clear();
			for (const [id, r] of pendingElicits) {
				r("cancel");
				emit({ type: "elicitation_resolved", id });
			}
			pendingElicits.clear();
		},
		stop() {
			closed = true;
			// Best-effort cancel the in-flight turn, then kill the adapter.
			if (conn && sessionId) {
				conn.cancel({ sessionId }).catch(() => {});
			}
			try {
				proc?.kill();
			} catch {
				// already gone
			}
		},
	};
}
