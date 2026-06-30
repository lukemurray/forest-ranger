import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentChatEvent, AgentPermissionMode } from "../../shared/types";
import { api, bus, subscribeAgentChat } from "../rpc";
import { markExited, updateSession } from "../lib/terminalStore";
import { CLAUDE_MODELS, PERMISSION_MODES, modelArg } from "../lib/chatConfig";
import { Select } from "./ui/Select";
import { Markdown } from "./Markdown";
import { SparkleIcon } from "./icons";
import styles from "./ChatPane.module.css";

type ChatItem =
	| { kind: "user"; text: string }
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
	const [modelValue, setModelValue] = useState(model || "default");
	const [mode, setMode] = useState<AgentPermissionMode>(permissionMode);
	const [input, setInput] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// Auto-name the tab from the first user message (once), unless renamed.
	const autoNamed = useRef(false);
	const renamedRef = useRef(renamed);
	renamedRef.current = renamed;

	useEffect(() => {
		setItems([]);
		setStatus("starting");

		function apply(event: AgentChatEvent) {
			switch (event.type) {
				case "system":
					setStatus((s) => (s === "starting" || s === "ended" ? "idle" : s));
					break;
				case "user_text":
					setItems((it) => [...it, { kind: "user", text: event.text }]);
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
			.agentChatStart({ sessionId: chatId, worktreeId, resume, permissionMode, model: modelArg(model) })
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

	function send() {
		const text = input.trim();
		if (!text || status === "working" || status === "ended" || status === "starting") return;
		bus.agentChatSend({ sessionId: chatId, text });
		setInput("");
		setStatus("working");
	}
	function stop() {
		bus.agentChatStop({ sessionId: chatId });
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
			send();
		}
	}

	const canSend = status === "idle" && input.trim().length > 0;

	return (
		<div className={styles.pane}>
			<div className={styles.header}>
				<SparkleIcon size={13} />
				<span className={styles.provider}>{agentLabel ?? "Claude"}</span>
				<span className={styles.status} data-status={status}>
					{status === "starting"
						? "starting…"
						: status === "working"
							? "working…"
							: status === "ended"
								? "ended"
								: "ready"}
				</span>
				{status === "working" && (
					<button className={styles.stop} onClick={stop}>
						Stop
					</button>
				)}
			</div>

			<div className={styles.scroll} ref={scrollRef}>
				{items.length === 0 && status !== "starting" && (
					<div className={styles.empty}>Send a message to start the conversation.</div>
				)}
				{items.map((item, i) => (
					<ChatRow key={i} item={item} onPermission={respondPermission} />
				))}
			</div>

			<div className={styles.composer}>
				<textarea
					ref={inputRef}
					className={styles.input}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={status === "ended" ? "Session ended" : "Message Claude…  (Enter to send)"}
					disabled={status === "ended"}
					rows={1}
					spellCheck={false}
				/>
				<div className={styles.composerBar}>
					<div className={styles.composerSelect}>
						<Select value={modelValue} onValueChange={changeModel} options={CLAUDE_MODELS} ariaLabel="Model" />
					</div>
					<div className={styles.composerSelectWide}>
						<Select value={mode} onValueChange={changeMode} options={PERMISSION_MODES} ariaLabel="Permission mode" />
					</div>
					<button className={styles.send} onClick={send} disabled={!canSend}>
						Send
					</button>
				</div>
			</div>
		</div>
	);
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
				<div className={styles.bubble}>{item.text}</div>
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
