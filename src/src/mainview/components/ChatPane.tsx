import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	AgentChatEvent,
	AgentPermissionMode,
	ChatAttachment,
} from "../../shared/types";
import { api, bus, subscribeAgentChat } from "../rpc";
import { markExited, updateSession } from "../lib/terminalStore";
import { CLAUDE_MODELS, PERMISSION_MODES, coerceModel, modelArg } from "../lib/chatConfig";
import { Select } from "./ui/Select";
import { Markdown } from "./Markdown";
import { CloseIcon, PlusIcon, SparkleIcon } from "./icons";
import styles from "./ChatPane.module.css";

/** A pending attachment held in the composer (with a preview URL). */
type LocalAttachment = {
	id: string;
	name: string;
	mediaType: string;
	data: string; // base64, no data: prefix
	dataUrl: string;
	isImage: boolean;
};
type Outgoing = { text: string; attachments: ChatAttachment[] };

type ChatItem =
	| { kind: "user"; text: string; attachments?: { name: string; isImage: boolean }[] }
	| { kind: "assistant"; text: string }
	| { kind: "thinking"; text: string }
	| {
			kind: "tool";
			id: string;
			name: string;
			input: unknown;
			status: "running" | "ok" | "error";
			summary?: string;
	  }
	| {
			kind: "permission";
			id: string;
			toolName: string;
			input: unknown;
			decided: "allow" | "deny" | null;
	  }
	| { kind: "error"; text: string };

type Status = "starting" | "idle" | "working" | "ended";

/**
 * One native agent chat rendered from the normalized {@link AgentChatEvent}
 * stream. Model and permission mode are switched in-place here: changing either
 * relaunches the agent with --resume, so the conversation continues.
 */
export function ChatPane({
	dockId,
	chatId,
	worktreeId,
	resume,
	permissionMode,
	model,
	agentLabel,
	renamed,
}: {
	dockId: string;
	chatId: string;
	worktreeId: string;
	resume: boolean;
	permissionMode: AgentPermissionMode;
	model: string | null;
	agentLabel?: string;
	renamed?: boolean;
}) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<Status>("starting");
	const [modelValue, setModelValue] = useState(() => coerceModel(model));
	const [mode, setMode] = useState<AgentPermissionMode>(permissionMode);
	const [input, setInput] = useState("");
	const [queue, setQueue] = useState<Outgoing[]>([]);
	const [resolvedModel, setResolvedModel] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
	const [viewing, setViewing] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	// Auto-name the tab from the first user message (once), unless renamed.
	const autoNamed = useRef(false);
	const renamedRef = useRef(renamed);
	renamedRef.current = renamed;

	useEffect(() => {
		setItems([]);
		setStatus("starting");
		setResolvedModel(null);
		setAttachments([]);
		setQueue([]);

		function apply(event: AgentChatEvent) {
			switch (event.type) {
				case "system":
					if (event.model) setResolvedModel(event.model);
					setStatus((s) => (s === "starting" || s === "ended" ? "idle" : s));
					break;
				case "user_text":
					setItems((it) => [
						...it,
						{ kind: "user", text: event.text, attachments: event.attachments },
					]);
					setStatus("working");
					if (!autoNamed.current) {
						autoNamed.current = true;
						if (!renamedRef.current) {
							updateSession(dockId, { name: deriveName(event.text) });
						}
					}
					break;
				case "assistant_text":
					setStatus("working");
					setItems((it) => mergeText(it, "assistant", event.text));
					break;
				case "thinking":
					setStatus("working");
					setItems((it) => mergeText(it, "thinking", event.text));
					break;
				case "tool_use":
					setItems((it) => [
						...it,
						{ kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
					]);
					break;
				case "tool_result":
					setItems((it) =>
						it.map((x) =>
							x.kind === "tool" && x.id === event.id
								? { ...x, status: event.ok ? "ok" : "error", summary: event.summary }
								: x,
						),
					);
					break;
				case "permission":
					setStatus("working");
					setItems((it) => [
						...it,
						{
							kind: "permission",
							id: event.id,
							toolName: event.toolName,
							input: event.input,
							decided: null,
						},
					]);
					break;
				case "permission_resolved":
					setItems((it) =>
						it.map((x) =>
							x.kind === "permission" && x.id === event.id
								? { ...x, decided: event.allow ? "allow" : "deny" }
								: x,
						),
					);
					break;
				case "result":
					setStatus("idle");
					break;
				case "error":
					setItems((it) => [...it, { kind: "error", text: event.message }]);
					setStatus((s) => (s === "ended" ? s : "idle"));
					break;
				case "exited":
					setStatus("ended");
					markExited(dockId);
					break;
			}
		}

		const unsub = subscribeAgentChat(chatId, apply);
		api
			.agentChatStart({
				sessionId: chatId,
				worktreeId,
				resume,
				permissionMode,
				model: modelArg(coerceModel(model)),
			})
			.then((res) => {
				if (!res.ok) {
					apply({ type: "error", message: res.error ?? "Failed to start chat" });
					setStatus("ended");
				} else {
					setStatus((s) => (s === "starting" ? "idle" : s));
				}
			});
		return () => {
			unsub();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatId, worktreeId]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [items, status]);

	// Auto-grow the input from one line up to ~30% of the viewport, then scroll.
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		const max = Math.round(window.innerHeight * 0.3);
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [input]);

	// Switch model/mode mid-conversation: persist on the tab and relaunch with
	// --resume so context carries over.
	function applyModelMode(nextModel: string, nextMode: AgentPermissionMode) {
		updateSession(dockId, { model: nextModel, permissionMode: nextMode });
		setStatus("idle");
		api.agentChatRestart({
			sessionId: chatId,
			worktreeId,
			permissionMode: nextMode,
			model: modelArg(nextModel),
		});
	}
	function changeModel(v: string) {
		setModelValue(v);
		applyModelMode(v, mode);
	}
	function changeMode(v: AgentPermissionMode) {
		setMode(v);
		applyModelMode(modelValue, v);
	}

	function addFiles(files: FileList | File[]) {
		for (const file of Array.from(files)) {
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = String(reader.result);
				const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
				setAttachments((a) => [
					...a,
					{
						id: crypto.randomUUID(),
						name: file.name || "pasted",
						mediaType: file.type || "application/octet-stream",
						data,
						dataUrl,
						isImage: (file.type || "").startsWith("image/"),
					},
				]);
			};
			reader.readAsDataURL(file);
		}
	}
	function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
		const files = Array.from(e.clipboardData.files);
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	}

	// Send when idle; while a turn is running, queue the message to fire when it
	// finishes (so you can line up follow-ups without waiting).
	function submit() {
		const text = input.trim();
		const atts: ChatAttachment[] = attachments.map((a) => ({
			name: a.name,
			mediaType: a.mediaType,
			data: a.data,
		}));
		if ((!text && atts.length === 0) || status === "starting" || status === "ended") return;
		const clear = () => {
			setInput("");
			setAttachments([]);
		};
		if (status === "working") {
			setQueue((q) => [...q, { text, attachments: atts }]);
			clear();
			return;
		}
		bus.agentChatSend({ sessionId: chatId, text, attachments: atts });
		clear();
		setStatus("working");
	}
	// Drain one queued message each time the agent returns to idle.
	useEffect(() => {
		if (status !== "idle" || queue.length === 0) return;
		const [next, ...rest] = queue;
		setQueue(rest);
		bus.agentChatSend({ sessionId: chatId, text: next.text, attachments: next.attachments });
		setStatus("working");
	}, [status, queue, chatId]);

	function stop() {
		bus.agentChatStop({ sessionId: chatId });
		setQueue([]);
		markExited(dockId);
		setStatus("ended");
	}
	function respondPermission(requestId: string, allow: boolean) {
		bus.agentChatPermission({ sessionId: chatId, requestId, allow });
		setItems((it) =>
			it.map((x) =>
				x.kind === "permission" && x.id === requestId
					? { ...x, decided: allow ? "allow" : "deny" }
					: x,
			),
		);
	}
	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	const hasContent = input.trim().length > 0 || attachments.length > 0;
	const working = status === "working";
	// Surface the resolved model only when it disagrees with the picked label
	// (e.g. a stale version label) — otherwise the picker already shows it.
	const pickedLabel = CLAUDE_MODELS.find((m) => m.value === modelValue)?.label;
	const showResolved = !!resolvedModel && friendlyModel(resolvedModel) !== pickedLabel;
	// With nothing to send while working, the button stops the turn; otherwise it
	// sends (queuing if a turn is in flight).
	const showStop = working && !hasContent;
	const canSend = hasContent && (status === "idle" || working);

	return (
		<div className={styles.pane}>
			<div className={styles.scroll} ref={scrollRef}>
				{items.length === 0 && status !== "starting" && (
					<div className={styles.empty}>Send a message to start the conversation.</div>
				)}
				{items.map((item, i) => (
					<ChatRow key={i} item={item} onPermission={respondPermission} />
				))}
				{queue.map((q, i) => (
					<div key={`q${i}`} className={styles.user} data-queued>
						<div className={styles.bubble} data-queued title="Queued — sends when the current turn finishes">
							{q.text || `📎 ${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}`}
						</div>
					</div>
				))}
			</div>

			<div className={styles.composer}>
				{attachments.length > 0 && (
					<div className={styles.attachments}>
						{attachments.map((a) => (
							<div key={a.id} className={styles.chip} data-image={a.isImage || undefined}>
								{a.isImage ? (
									<button
										type="button"
										className={styles.chipThumb}
										onClick={() => setViewing(a.dataUrl)}
										title={`${a.name} — click to view`}
									>
										<img src={a.dataUrl} alt={a.name} />
									</button>
								) : (
									<span className={styles.chipFile} title={a.name}>
										{a.name}
									</span>
								)}
								<button
									type="button"
									className={styles.chipRemove}
									onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
									aria-label={`Remove ${a.name}`}
								>
									<CloseIcon size={11} />
								</button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={inputRef}
					className={styles.input}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					placeholder={status === "ended" ? "Session ended" : "Message Claude…  (Enter to send, paste images)"}
					disabled={status === "ended"}
					rows={1}
					spellCheck={false}
				/>
				<div className={styles.composerBar}>
					<button
						type="button"
						className={styles.attach}
						onClick={() => fileInputRef.current?.click()}
						title="Attach files or images"
						disabled={status === "ended"}
					>
						<PlusIcon size={15} />
					</button>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							if (e.target.files) addFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<div className={styles.composerSelect}>
						<Select
							value={modelValue}
							onValueChange={changeModel}
							options={CLAUDE_MODELS}
							ariaLabel="Provider and model"
							leading={
								<span className={styles.provider} data-working={working || undefined}>
									<SparkleIcon size={13} />
									{agentLabel ?? "Claude"}
								</span>
							}
						/>
					</div>
					{showResolved && (
						<span className={styles.resolvedModel} title={resolvedModel ?? undefined}>
							{friendlyModel(resolvedModel as string)}
						</span>
					)}
					<div className={styles.composerSelectWide}>
						<Select value={mode} onValueChange={changeMode} options={PERMISSION_MODES} ariaLabel="Permission mode" />
					</div>
					{showStop ? (
						<button className={styles.stopBtn} onClick={stop}>
							Stop
						</button>
					) : (
						<button className={styles.send} onClick={submit} disabled={!canSend}>
							Send
						</button>
					)}
				</div>
			</div>

			{viewing && (
				<div className={styles.lightbox} onClick={() => setViewing(null)}>
					<img src={viewing} alt="attachment" />
				</div>
			)}
		</div>
	);
}

/** Turn a resolved model id (claude-opus-4-8-…) into a friendly label (Opus 4.8). */
function friendlyModel(id: string): string {
	const m = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(id);
	if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
	return id.replace(/^claude-/, "");
}

/** A short tab name derived from the first user message. */
function deriveName(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 40 ? `${line.slice(0, 40).trimEnd()}…` : line || "New chat";
}

function mergeText(items: ChatItem[], kind: "assistant" | "thinking", text: string): ChatItem[] {
	const last = items[items.length - 1];
	if (last && last.kind === kind) {
		return [...items.slice(0, -1), { ...last, text: last.text + text }];
	}
	return [...items, { kind, text }];
}

function ChatRow({
	item,
	onPermission,
}: {
	item: ChatItem;
	onPermission: (id: string, allow: boolean) => void;
}) {
	if (item.kind === "user") {
		return (
			<div className={styles.user}>
				<div className={styles.bubble}>
					{item.attachments && item.attachments.length > 0 && (
						<div className={styles.sentAttachments}>
							{item.attachments.map((a, j) => (
								<span key={j} className={styles.sentChip}>
									{a.isImage ? "🖼" : "📎"} {a.name}
								</span>
							))}
						</div>
					)}
					{item.text}
				</div>
			</div>
		);
	}
	if (item.kind === "assistant") {
		return (
			<div className={styles.assistant}>
				<Markdown text={item.text} />
			</div>
		);
	}
	if (item.kind === "thinking") {
		return (
			<details className={styles.thinking}>
				<summary>Thinking</summary>
				<div className={styles.thinkingBody}>{item.text}</div>
			</details>
		);
	}
	if (item.kind === "error") {
		return <div className={styles.error}>{item.text}</div>;
	}
	if (item.kind === "permission") {
		return (
			<div className={styles.permission} data-decided={item.decided ?? undefined}>
				<div className={styles.permHead}>
					Allow <strong>{item.toolName}</strong>?
				</div>
				<div className={styles.permInput}>{describeInput(item.input)}</div>
				{item.decided ? (
					<div className={styles.permDecided}>
						{item.decided === "allow" ? "Allowed" : "Denied"}
					</div>
				) : (
					<div className={styles.permActions}>
						<button
							className={styles.permAllow}
							onClick={() => onPermission(item.id, true)}
						>
							Allow
						</button>
						<button
							className={styles.permDeny}
							onClick={() => onPermission(item.id, false)}
						>
							Deny
						</button>
					</div>
				)}
			</div>
		);
	}
	return (
		<div className={styles.tool} data-status={item.status} title={item.summary}>
			<span className={styles.toolDot} />
			<span className={styles.toolName}>{item.name}</span>
			{item.summary && <span className={styles.toolSummary}>{item.summary}</span>}
		</div>
	);
}

/** A compact one-line description of a tool's input for the permission prompt. */
function describeInput(input: unknown): string {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		const primary = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern;
		if (typeof primary === "string") return primary;
	}
	const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
	return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
