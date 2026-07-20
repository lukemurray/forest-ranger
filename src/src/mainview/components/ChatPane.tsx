import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	AgentChatEvent,
	AgentMode,
	AgentPermissionMode,
	AgentProvider,
	ChatAttachment,
	ConfigOption,
	ElicitationField,
	ElicitationValue,
	PermissionOption,
	PlanEntryStatus,
} from "../../shared/types";
import { api, bus, subscribeAgentChat } from "../rpc";
import { markExited, updateSession } from "../lib/terminalStore";
import {
	PERMISSION_MODES,
	coerceModel,
	coerceProvider,
	modelArg,
	providerLabel,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { Markdown } from "./Markdown";
import { CloseIcon, PlusIcon } from "./icons";
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
			options: PermissionOption[];
			/** The label of the chosen option once answered, else null. */
			decided: string | null;
	  }
	| {
			kind: "elicitation";
			id: string;
			mode: "form" | "url";
			message: string;
			fields: ElicitationField[];
			url?: string;
			done: boolean;
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
	provider,
	resume,
	permissionMode,
	model,
	renamed,
}: {
	dockId: string;
	chatId: string;
	worktreeId: string;
	provider: AgentProvider;
	resume: boolean;
	permissionMode: AgentPermissionMode;
	model: string | null;
	agentLabel?: string;
	renamed?: boolean;
}) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<Status>("starting");
	const [providerValue, setProviderValue] = useState(() => coerceProvider(provider));
	const [modelValue, setModelValue] = useState(() =>
		coerceModel(coerceProvider(provider), model),
	);
	const [mode, setMode] = useState<AgentPermissionMode>(permissionMode);
	// Agent-driven surfaces (from ACP session updates). Empty when unsupported.
	const [plan, setPlan] = useState<{ content: string; status: PlanEntryStatus }[]>([]);
	const [commands, setCommands] = useState<{ name: string; description: string }[]>([]);
	const [agentModes, setAgentModes] = useState<AgentMode[]>([]);
	const [agentModeId, setAgentModeId] = useState<string | null>(null);
	const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
	const [input, setInput] = useState("");
	const [queue, setQueue] = useState<Outgoing[]>([]);
	const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
	const [viewing, setViewing] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const dragDepth = useRef(0);
	// A provider/model switch requested mid-turn, applied once the turn ends.
	const pendingRelaunch = useRef<{ provider: AgentProvider; model: string } | null>(null);
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
		setAttachments([]);
		setQueue([]);
		setPlan([]);
		setCommands([]);
		setAgentModes([]);
		setAgentModeId(null);
		setConfigOptions([]);

		function apply(event: AgentChatEvent) {
			switch (event.type) {
				case "system":
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
							options: event.options,
							decided: null,
						},
					]);
					break;
				case "permission_resolved":
					setItems((it) =>
						it.map((x) =>
							x.kind === "permission" && x.id === event.id
								? { ...x, decided: event.label }
								: x,
						),
					);
					break;
				case "elicitation":
					setStatus("working");
					setItems((it) => [
						...it,
						{
							kind: "elicitation",
							id: event.id,
							mode: event.mode,
							message: event.message,
							fields: event.fields,
							url: event.url,
							done: false,
						},
					]);
					break;
				case "elicitation_resolved":
					setItems((it) =>
						it.map((x) =>
							x.kind === "elicitation" && x.id === event.id ? { ...x, done: true } : x,
						),
					);
					break;
				case "plan":
					setPlan(event.entries);
					break;
				case "commands":
					setCommands(event.commands);
					break;
				case "modes":
					setAgentModes(event.available);
					setAgentModeId(event.current);
					break;
				case "configOptions":
					setConfigOptions(event.options);
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
				provider: coerceProvider(provider),
				resume,
				permissionMode,
				model: modelArg(coerceModel(coerceProvider(provider), model)),
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

	// Provider/model need a fresh agent process, so switching them relaunches
	// (resuming the session so context carries over). We never relaunch mid-turn —
	// see the deferral below — so a running task is never interrupted.
	function relaunch(nextProvider: AgentProvider, nextModel: string) {
		setStatus("idle");
		api.agentChatRestart({
			sessionId: chatId,
			worktreeId,
			provider: nextProvider,
			permissionMode: mode,
			model: modelArg(nextModel),
		});
	}
	// Switching provider needs a different adapter → relaunch (deferred if a turn
	// is streaming). Model within a provider is a live config option (below).
	function changeProvider(p: AgentProvider) {
		if (p === providerValue) return;
		const m = coerceModel(p, modelValue);
		setProviderValue(p);
		setModelValue(m);
		updateSession(dockId, { provider: p, model: m });
		if (status === "working") pendingRelaunch.current = { provider: p, model: m };
		else relaunch(p, m);
	}
	// Live agent setting (model/mode/effort/…) — no relaunch, applies to this session.
	function changeConfig(configId: string, value: string) {
		setConfigOptions((opts) =>
			opts.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
		);
		bus.agentChatSetConfigOption({ sessionId: chatId, configId, value });
	}
	// Fallback model picker (agents that don't expose config options) → relaunch.
	function changeModel(m: string) {
		if (m === modelValue) return;
		setModelValue(m);
		updateSession(dockId, { model: m });
		if (status === "working") pendingRelaunch.current = { provider: providerValue, model: m };
		else relaunch(providerValue, m);
	}
	function changeMode(v: AgentPermissionMode) {
		setMode(v);
		updateSession(dockId, { permissionMode: v });
		// Permission mode is enforced client-side in the driver — change it live,
		// no relaunch, no interruption of the current turn.
		bus.agentChatSetMode({ sessionId: chatId, permissionMode: v });
	}
	function changeSessionMode(modeId: string) {
		setAgentModeId(modeId);
		bus.agentChatSetSessionMode({ sessionId: chatId, modeId });
	}

	// Apply a deferred provider/model switch once the in-flight turn completes.
	useEffect(() => {
		if (status === "idle" && pendingRelaunch.current) {
			const { provider: p, model: m } = pendingRelaunch.current;
			pendingRelaunch.current = null;
			relaunch(p, m);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status]);

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
	// Drag-and-drop anywhere in the pane. A depth counter avoids the flicker from
	// dragenter/dragleave firing on child elements.
	const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
	function onDragEnter(e: React.DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth.current += 1;
		setDragOver(true);
	}
	function onDragOver(e: React.DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}
	function onDragLeave(e: React.DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth.current -= 1;
		if (dragDepth.current <= 0) {
			dragDepth.current = 0;
			setDragOver(false);
		}
	}
	function onDrop(e: React.DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth.current = 0;
		setDragOver(false);
		if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
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
		// Cancel the running turn but keep the session alive so the user can keep
		// chatting (the agent resolves the turn with a "cancelled" stop reason).
		bus.agentChatCancel({ sessionId: chatId });
		setQueue([]);
		setStatus("idle");
	}
	function respondPermission(requestId: string, optionId: string, label: string) {
		bus.agentChatPermission({ sessionId: chatId, requestId, optionId });
		setItems((it) =>
			it.map((x) =>
				x.kind === "permission" && x.id === requestId ? { ...x, decided: label } : x,
			),
		);
	}
	function submitElicit(
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	) {
		bus.agentChatElicit({ sessionId: chatId, id, action, content });
		setItems((it) =>
			it.map((x) => (x.kind === "elicitation" && x.id === id ? { ...x, done: true } : x)),
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
	// Slash-command autocomplete: match while the input is a bare "/name" prefix.
	const slashQuery = /^\/(\S*)$/.exec(input);
	const slashMatches = slashQuery
		? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery[1].toLowerCase())).slice(0, 6)
		: [];
	const planDone = plan.filter((e) => e.status === "completed").length;
	// The permission/edit mode config option (kept inline, not in the settings popup).
	const modeOption = configOptions.find((o) => o.id === "mode" || o.category === "mode");
	// Surface the resolved model only when it disagrees with the picked label
	// (e.g. a stale version label) — otherwise the picker already shows it.
	// With nothing to send while working, the button stops the turn; otherwise it
	// sends (queuing if a turn is in flight).
	const showStop = working && !hasContent;
	const canSend = hasContent && (status === "idle" || working);

	return (
		<div
			className={styles.pane}
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			{dragOver && (
				<div className={styles.dropZone}>
					<PlusIcon size={22} />
					Drop files to attach
				</div>
			)}
			<div className={styles.scroll} ref={scrollRef}>
				{items.length === 0 && status !== "starting" && (
					<div className={styles.empty}>Send a message to start the conversation.</div>
				)}
				{items.map((item, i) => (
					<ChatRow
						key={i}
						item={item}
						onPermission={respondPermission}
						onElicit={submitElicit}
					/>
				))}
				{queue.map((q, i) => (
					<div key={`q${i}`} className={styles.user} data-queued>
						<div className={styles.bubble} data-queued title="Queued — sends when the current turn finishes">
							{q.text || `📎 ${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}`}
						</div>
					</div>
				))}
			</div>

			{plan.length > 0 && (
				<details className={styles.plan}>
					<summary className={styles.planHead}>
						Plan · {planDone}/{plan.length} done
					</summary>
					<ul className={styles.planList}>
						{plan.map((e, i) => (
							<li key={i} className={styles.planItem} data-status={e.status}>
								<span className={styles.planMark}>
									{e.status === "completed" ? "●" : e.status === "in_progress" ? "◐" : "○"}
								</span>
								{e.content}
							</li>
						))}
					</ul>
				</details>
			)}

			<div className={styles.composer}>
				{slashMatches.length > 0 && (
					<div className={styles.slashMenu}>
						{slashMatches.map((c) => (
							<button
								key={c.name}
								type="button"
								className={styles.slashItem}
								onClick={() => {
									setInput(`/${c.name} `);
									inputRef.current?.focus();
								}}
							>
								<span className={styles.slashName}>/{c.name}</span>
								<span className={styles.slashDesc}>{c.description}</span>
							</button>
						))}
					</div>
				)}
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
					placeholder={
						status === "ended"
							? "Session ended"
							: `Message ${providerLabel(providerValue)}…  (Enter to send, paste images)`
					}
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
					<ChatSettingsMenu
						provider={providerValue}
						onProvider={changeProvider}
						configOptions={configOptions}
						onConfig={changeConfig}
						model={modelValue}
						onModel={changeModel}
						working={working}
					/>
					{/* Permission/edit mode stays inline as a quick toggle, pinned right. */}
					<div className={styles.modeGroup}>
						<span className={styles.modeLabel}>Mode</span>
						<div className={styles.composerSelectWide}>
							{modeOption ? (
								<Select
									value={modeOption.currentValue}
									onValueChange={(v) => changeConfig(modeOption.id, v)}
									options={modeOption.options.map((x) => ({ value: x.value, label: x.label }))}
									ariaLabel="Mode"
								/>
							) : agentModes.length > 0 ? (
								<Select
									value={agentModeId ?? agentModes[0].id}
									onValueChange={changeSessionMode}
									options={agentModes.map((m) => ({ value: m.id, label: m.name }))}
									ariaLabel="Agent mode"
								/>
							) : (
								<Select value={mode} onValueChange={changeMode} options={PERMISSION_MODES} ariaLabel="Permission mode" />
							)}
						</div>
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
	onElicit,
}: {
	item: ChatItem;
	onPermission: (id: string, optionId: string, label: string) => void;
	onElicit: (
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	) => void;
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
	if (item.kind === "elicitation") {
		return <ElicitationCard item={item} onElicit={onElicit} />;
	}
	if (item.kind === "permission") {
		return (
			<div className={styles.permission} data-decided={item.decided ?? undefined}>
				<div className={styles.permHead}>
					Allow <strong>{item.toolName}</strong>?
				</div>
				<div className={styles.permInput}>{describeInput(item.input)}</div>
				{item.decided ? (
					<div className={styles.permDecided}>{item.decided}</div>
				) : (
					<div className={styles.permActions}>
						{item.options.map((o) => (
							<button
								key={o.id}
								className={o.kind.startsWith("allow") ? styles.permAllow : styles.permDeny}
								onClick={() => onPermission(item.id, o.id, o.label)}
							>
								{o.label}
							</button>
						))}
					</div>
				)}
			</div>
		);
	}
	// With output, the tool is an expandable disclosure: a one-line header with the
	// full result rendered as Markdown inside. Without output (still running), just
	// the header.
	if (!item.summary) {
		return (
			<div className={styles.tool} data-status={item.status}>
				<div className={styles.toolHeader}>
					<span className={styles.toolDot} />
					<span className={styles.toolName}>{item.name}</span>
				</div>
			</div>
		);
	}
	return (
		<details className={styles.tool} data-status={item.status}>
			<summary className={styles.toolHeader}>
				<span className={styles.toolDot} />
				<span className={styles.toolName}>{item.name}</span>
				<span className={styles.toolSummary}>{toolPreview(item.summary)}</span>
			</summary>
			<div className={styles.toolBody}>
				<Markdown text={item.summary} />
			</div>
		</details>
	);
}

/** First meaningful line of tool output, for the collapsed header. */
function toolPreview(s: string): string {
	const line =
		s
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith("```")) ?? "";
	return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** A structured elicitation from the agent: a form to fill in, or a URL to open. */
function ElicitationCard({
	item,
	onElicit,
}: {
	item: Extract<ChatItem, { kind: "elicitation" }>;
	onElicit: (
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	) => void;
}) {
	const [values, setValues] = useState<Record<string, ElicitationValue>>(() => {
		const init: Record<string, ElicitationValue> = {};
		for (const f of item.fields) {
			if (f.default !== undefined) init[f.key] = f.default;
			else if (f.input === "boolean") init[f.key] = false;
			else if (f.input === "multiselect") init[f.key] = [];
			else init[f.key] = "";
		}
		return init;
	});
	const set = (key: string, v: ElicitationValue) =>
		setValues((s) => ({ ...s, [key]: v }));

	if (item.mode === "url") {
		return (
			<div className={styles.elicit} data-done={item.done || undefined}>
				<div className={styles.elicitMsg}>{item.message}</div>
				{item.done ? (
					<div className={styles.permDecided}>Done</div>
				) : (
					<div className={styles.elicitActions}>
						<button
							className={styles.permAllow}
							onClick={() => item.url && api.openUrl({ url: item.url })}
						>
							Open link
						</button>
						<button className={styles.permDeny} onClick={() => onElicit(item.id, "cancel")}>
							Dismiss
						</button>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className={styles.elicit} data-done={item.done || undefined}>
			<div className={styles.elicitMsg}>{item.message}</div>
			<div className={styles.elicitFields}>
				{item.fields.map((f) => (
					<label key={f.key} className={styles.elicitField}>
						<span className={styles.elicitFieldLabel}>
							{f.label}
							{f.required && <span className={styles.elicitReq}> *</span>}
						</span>
						{f.description && <span className={styles.elicitDesc}>{f.description}</span>}
						<ElicitationInput
							field={f}
							name={`${item.id}-${f.key}`}
							value={values[f.key]}
							disabled={item.done}
							onChange={(v) => set(f.key, v)}
						/>
					</label>
				))}
			</div>
			{item.done ? (
				<div className={styles.permDecided}>Submitted</div>
			) : (
				<div className={styles.elicitActions}>
					<button
						className={styles.permAllow}
						onClick={() => onElicit(item.id, "accept", values)}
					>
						Submit
					</button>
					<button className={styles.permDeny} onClick={() => onElicit(item.id, "decline")}>
						Decline
					</button>
				</div>
			)}
		</div>
	);
}

function ElicitationInput({
	field,
	name,
	value,
	disabled,
	onChange,
}: {
	field: ElicitationField;
	/** Radio-group name, unique per field within the chat. */
	name: string;
	value: ElicitationValue | undefined;
	disabled: boolean;
	onChange: (v: ElicitationValue) => void;
}) {
	if (field.input === "boolean") {
		return (
			<input
				type="checkbox"
				className={styles.elicitCheckbox}
				checked={value === true}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
		);
	}
	if (field.input === "select") {
		// Radio group: every option visible inline, not hidden in a dropdown.
		return (
			<div className={styles.elicitRadios} role="radiogroup">
				{field.options?.map((o) => (
					<label key={o.value} className={styles.elicitRadio}>
						<input
							type="radio"
							name={name}
							disabled={disabled}
							checked={value === o.value}
							onChange={() => onChange(o.value)}
						/>
						{o.label}
					</label>
				))}
			</div>
		);
	}
	if (field.input === "multiselect") {
		const arr = Array.isArray(value) ? value : [];
		return (
			<div className={styles.elicitChecks}>
				{field.options?.map((o) => (
					<label key={o.value} className={styles.elicitCheck}>
						<input
							type="checkbox"
							disabled={disabled}
							checked={arr.includes(o.value)}
							onChange={(e) =>
								onChange(
									e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value),
								)
							}
						/>
						{o.label}
					</label>
				))}
			</div>
		);
	}
	const isNum = field.input === "number" || field.input === "integer";
	return (
		<input
			className={styles.elicitInput}
			type={isNum ? "number" : "text"}
			step={field.input === "integer" ? 1 : undefined}
			disabled={disabled}
			value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
			onChange={(e) =>
				onChange(isNum ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)
			}
		/>
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
