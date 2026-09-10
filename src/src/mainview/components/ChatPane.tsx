import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { FOREST_WORDS, nextForestWord } from "../lib/forestWords";
import {
	PERMISSION_MODES,
	coerceModel,
	coerceProvider,
	getChatConfig,
	modelArg,
	providerLabel,
	rememberProviderModes,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { Markdown } from "./Markdown";
import { clockTime, timeDivider } from "../lib/format";
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
	| { kind: "user"; text: string; attachments?: { name: string; isImage: boolean }[]; ts?: number }
	| { kind: "assistant"; text: string; ts?: number }
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
	initialPrompt,
	active,
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
	initialPrompt?: string;
	/** Whether this pane is the visible tab — layout measured while hidden is wrong. */
	active: boolean;
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
				case "history_reset":
					// A (re)play of the full buffer follows — start from a clean transcript
					// so overlapping reattach replays can't stack into duplicates.
					setItems([]);
					setPlan([]);
					break;
				case "system":
					setStatus((s) => (s === "starting" || s === "ended" ? "idle" : s));
					break;
				case "user_text":
					setItems((it) => [
						...it,
						{ kind: "user", text: event.text, attachments: event.attachments, ts: event.ts },
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
					setItems((it) => mergeText(it, "assistant", event.text, event.ts));
					break;
				case "thinking":
					setStatus("working");
					setItems((it) => mergeText(it, "thinking", event.text, event.ts));
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

	// Follow new output while the user is parked near the bottom (so the latest
	// output stays in view). If they've scrolled up to read, don't yank them down.
	// Sticky question headers are pure CSS section-stickies (see `.turn`); long ones
	// are clamped with a Show more toggle (see UserBubble), not a scroll-driven cap.
	const stick = useRef(true);
	const onScroll = () => {
		const el = scrollRef.current;
		if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	};
	// `active` is a dep because a tab mounted while hidden (display:none) measures
	// zero height — re-run on activation so the newest message is in view.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && active && stick.current) el.scrollTop = el.scrollHeight;
	}, [items, status, active]);

	// Auto-grow the input from one line up to ~30% of the viewport, then scroll.
	// `active` dep for the same reason: scrollHeight is 0 while the tab is hidden,
	// which would otherwise leave the textarea collapsed until the next keystroke.
	useLayoutEffect(() => {
		const el = inputRef.current;
		if (!el || !active) return;
		el.style.height = "auto";
		const max = Math.round(window.innerHeight * 0.3);
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [input, active]);

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

	// Learn this provider's mode options (so Settings can offer them), and — on a
	// fresh chat only — switch to the user's preferred default mode once. Resumed
	// chats keep whatever mode they had.
	const appliedDefaultMode = useRef(resume);
	useEffect(() => {
		const modeOpt = configOptions.find((o) => o.id === "mode" || o.category === "mode");
		if (!modeOpt) return;
		rememberProviderModes(
			providerValue,
			modeOpt.options.map((o) => ({ value: o.value, label: o.label })),
		);
		if (!appliedDefaultMode.current) {
			appliedDefaultMode.current = true;
			const want = getChatConfig().defaultModeByProvider?.[providerValue];
			if (want && want !== modeOpt.currentValue && modeOpt.options.some((o) => o.value === want)) {
				bus.agentChatSetConfigOption({ sessionId: chatId, configId: modeOpt.id, value: want });
			}
		}
	}, [configOptions, providerValue, chatId]);

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
		stick.current = true; // you sent something — jump to it
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

	// Fire a preset prompt (e.g. "Agent merge") once, the first time a fresh session
	// is ready. It's a one-shot: consume it off the session so a later remount (which
	// resets refs and sees status flip back to idle) can't re-send it. Also skipped on
	// resume and whenever the session already has history.
	const sentInitial = useRef(false);
	useEffect(() => {
		if (resume || !initialPrompt || sentInitial.current || status !== "idle") return;
		sentInitial.current = true;
		updateSession(dockId, { initialPrompt: undefined });
		if (items.length > 0) return; // already has messages — don't inject
		bus.agentChatSend({ sessionId: chatId, text: initialPrompt, attachments: [] });
		setStatus("working");
	}, [status, resume, initialPrompt, chatId, dockId, items.length]);

	function stop() {
		// Cancel the running turn but keep the session alive so the user can keep
		// chatting (the agent resolves the turn with a "cancelled" stop reason).
		bus.agentChatCancel({ sessionId: chatId });
		// Don't silently drop a queued follow-up — return its text to the composer.
		if (queue.length > 0) {
			const pending = queue.map((q) => q.text).filter(Boolean).join("\n\n");
			if (pending) setInput((v) => (v.trim() ? `${pending}\n\n${v}` : pending));
			setQueue([]);
		}
		setStatus("idle");
	}

	// "Steer": interrupt the current turn and send this queued message as a redirect.
	// We cancel and move it to the front but let the drain-on-idle effect do the send
	// once the cancelled turn actually ends — so we never prompt over a live turn.
	function steer(index: number) {
		setQueue((q) => {
			const picked = q[index];
			if (!picked) return q;
			return [picked, ...q.slice(0, index), ...q.slice(index + 1)];
		});
		bus.agentChatCancel({ sessionId: chatId });
	}
	// Stable across renders so memoized rows don't re-render every streamed token.
	const respondPermission = useCallback(
		(requestId: string, optionId: string, label: string) => {
			bus.agentChatPermission({ sessionId: chatId, requestId, optionId });
			setItems((it) =>
				it.map((x) =>
					x.kind === "permission" && x.id === requestId ? { ...x, decided: label } : x,
				),
			);
		},
		[chatId],
	);
	const submitElicit = useCallback(
		(
			id: string,
			action: "accept" | "decline" | "cancel",
			content?: Record<string, ElicitationValue>,
		) => {
			bus.agentChatElicit({ sessionId: chatId, id, action, content });
			setItems((it) =>
				it.map((x) => (x.kind === "elicitation" && x.id === id ? { ...x, done: true } : x)),
			);
		},
		[chatId],
	);
	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	// Rebuilt only when items change (not on every keystroke/config re-render).
	const renderNodes = useMemo(() => buildRenderNodes(items), [items]);
	// Group nodes into turns: each starts at a new question (a user cluster) and runs
	// through its answer. Wrapping a turn constrains its sticky question header to that
	// turn's box, so the next turn scrolls up and *pushes* the previous header out.
	const sections = useMemo(() => buildSections(renderNodes), [renderNodes]);
	const dividers = useMemo(() => buildDividers(sections), [sections]);
	const lastNode = renderNodes[renderNodes.length - 1];

	const hasContent = input.trim().length > 0 || attachments.length > 0;
	const working = status === "working";

	// Show the activity indicator while working — but not once the answer is
	// streaming (it's visible as the last message) or during a tool's own output.
	const showActivity = useMemo(() => {
		if (status === "starting") return true;
		if (status !== "working") return false;
		return items[items.length - 1]?.kind !== "assistant";
	}, [status, items]);

	// Rotate a whimsical forest word while working, à la Claude Code's status line.
	// Pure random, but skipping the last 7 shown so it doesn't feel repetitive.
	const [forestWord, setForestWord] = useState(FOREST_WORDS[0]);
	const recentWords = useRef<string[]>([]);
	useEffect(() => {
		if (status !== "working") return;
		const rotate = () => {
			const w = nextForestWord(recentWords.current);
			recentWords.current = [w, ...recentWords.current].slice(0, 7);
			setForestWord(w);
		};
		rotate();
		const t = setInterval(rotate, 7000);
		return () => clearInterval(t);
	}, [status]);
	const activity = !showActivity
		? null
		: status === "starting"
			? "Lacing up…"
			: `${forestWord}…`;
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
			<div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
				{items.length === 0 && status !== "starting" && (
					<div className={styles.empty}>Send a message to start the conversation.</div>
				)}
				{sections.map((sec, si) => (
					<div key={si} className={styles.turn}>
						{dividers[si] && (
							<div className={styles.timeDivider}>
								<span>{dividers[si]}</span>
							</div>
						)}
						{sec.nodes.map((node, ni) =>
							node.kind === "process" ? (
								<ProcessStrip
									key={ni}
									steps={node.steps}
									active={working && node === lastNode}
									onPermission={respondPermission}
									onElicit={submitElicit}
								/>
							) : (
								<ChatRow
									key={ni}
									item={node}
									pinned={ni === sec.headerIdx}
									onPermission={respondPermission}
									onElicit={submitElicit}
								/>
							),
						)}
					</div>
				))}
				{activity && (
					<div className={styles.activity}>
						<svg
							className={styles.treeLoader}
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12 2 4 14h16L12 2Z" />
							<path d="M12 14v8" />
							<path d="M8 9h8" />
						</svg>
						{/* keyed so each new word remounts and replays the fade-up */}
						<span key={activity} className={styles.activityLabel}>
							{activity}
						</span>
					</div>
				)}
				{queue.map((q, i) => (
					<div key={`q${i}`} className={styles.user} data-queued>
						<div className={styles.queued}>
							<div className={styles.bubble} data-queued title="Queued — sends when the current turn finishes">
								{q.text || `📎 ${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}`}
							</div>
							{working && (
								<button
									className={styles.steer}
									onClick={() => steer(i)}
									title="Interrupt the current turn and send this now"
								>
									Steer
								</button>
							)}
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

function mergeText(
	items: ChatItem[],
	kind: "assistant" | "thinking",
	text: string,
	ts?: number,
): ChatItem[] {
	const last = items[items.length - 1];
	if (last && last.kind === kind) {
		return [...items.slice(0, -1), { ...last, text: last.text + text }];
	}
	// ts only on the first chunk — it's when the turn's answer began.
	return [...items, kind === "assistant" ? { kind, text, ts } : { kind, text }];
}

type RenderNode = ChatItem | { kind: "process"; steps: ChatItem[] };
type Section = { nodes: RenderNode[]; headerIdx: number };

/**
 * Split the flat node list into turns for sticky section headers. A turn begins at
 * a new question (a user node not directly preceded by another user) and includes
 * every node up to the next question. `headerIdx` is the last of a turn's leading
 * consecutive questions — the one that sticks (so back-to-back questions pin the
 * latest); -1 when a turn has no question (e.g. an opening assistant message).
 */
/** The earliest timestamp in a turn (its question, else the answer's first chunk). */
function sectionStartTs(sec: Section): number | undefined {
	for (const node of sec.nodes) {
		if (node.kind === "user" || node.kind === "assistant") {
			if (node.ts) return node.ts;
		} else if (node.kind === "process") {
			for (const step of node.steps) if (step.kind === "assistant" && step.ts) return step.ts;
		}
	}
	return undefined;
}

const GAP_MS = 60 * 60 * 1000; // insert a time divider when turns are >1h apart

/** Per-section divider labels: set only when a turn begins >1h after the last. */
function buildDividers(sections: Section[]): (string | null)[] {
	let prev: number | undefined;
	return sections.map((sec) => {
		const ts = sectionStartTs(sec);
		if (ts === undefined) return null;
		const label = prev !== undefined && ts - prev > GAP_MS ? timeDivider(ts) : null;
		prev = ts;
		return label;
	});
}

function buildSections(nodes: RenderNode[]): Section[] {
	const sections: Section[] = [];
	let prevWasUser = false;
	for (const node of nodes) {
		const isUser = node.kind === "user";
		if (sections.length === 0 || (isUser && !prevWasUser)) {
			sections.push({ nodes: [], headerIdx: -1 });
		}
		const sec = sections[sections.length - 1];
		sec.nodes.push(node);
		if (isUser) sec.headerIdx = sec.nodes.length - 1;
		prevWasUser = isUser;
	}
	return sections;
}

/**
 * Fold only runs of consecutive tool calls into a collapsible "Worked" strip.
 * All prose — assistant answers, interstitial narration, thinking — stays visible
 * inline, since that text is often what makes the final result read correctly. A
 * lone tool renders as its own (already collapsible) row rather than a 1-step strip.
 */
function buildRenderNodes(items: ChatItem[]): RenderNode[] {
	const nodes: RenderNode[] = [];
	let buf: ChatItem[] = [];
	const flush = () => {
		if (buf.length > 1) nodes.push({ kind: "process", steps: buf });
		else if (buf.length === 1) nodes.push(buf[0]);
		buf = [];
	};
	for (const item of items) {
		if (item.kind === "tool") buf.push(item);
		else {
			flush();
			nodes.push(item);
		}
	}
	flush();
	return nodes;
}

/** One-line hint for a process step, shown in the collapsed strip summary. */
function stepHint(item: ChatItem): string {
	if (item.kind === "tool") return item.name;
	if (item.kind === "assistant" || item.kind === "thinking")
		return item.text.replace(/\s+/g, " ").trim().slice(0, 60);
	return "";
}

/** Collapsible "Working…" strip wrapping a turn's thinking + tool + narration steps. */
function ProcessStrip({
	steps,
	active = false,
	onPermission,
	onElicit,
}: {
	steps: ChatItem[];
	/** True for the in-flight strip: pulse the dot and label it live. */
	active?: boolean;
	onPermission: (id: string, optionId: string, label: string) => void;
	onElicit: (
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	) => void;
}) {
	const last = steps[steps.length - 1];
	const hint = last ? stepHint(last) : "";
	return (
		<details className={styles.process} data-active={active || undefined}>
			<summary className={styles.processHead}>
				{/* No "Working…" verb — the tree + forest word is the single live status;
				    this strip just labels the tool steps it folds (dot pulses while active). */}
				<span className={styles.processSpinner} />
				<span className={styles.processTitle}>
					{steps.length} step{steps.length === 1 ? "" : "s"}
				</span>
				{hint && <span className={styles.processMeta}>· {hint}</span>}
			</summary>
			<div className={styles.processBody}>
				{steps.map((s, i) => (
					<ChatRow key={i} item={s} onPermission={onPermission} onElicit={onElicit} />
				))}
			</div>
		</details>
	);
}

/** A sent user message: long ones clamp with an inline Show more/less toggle so a
 *  big paste never dominates the view (and stays small when pinned as a header). */
function UserBubble({
	text,
	attachments,
	title,
}: {
	text: string;
	attachments?: { name: string; isImage: boolean }[];
	title?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = contentRef.current;
		// scrollHeight is the full content height even while clamped by max-height.
		if (el) setOverflows(el.scrollHeight > CLAMP_PX + 8);
	}, [text]);

	return (
		<div className={styles.bubble} title={title}>
			{attachments && attachments.length > 0 && (
				<div className={styles.sentAttachments}>
					{attachments.map((a, j) => (
						<span key={j} className={styles.sentChip}>
							{a.isImage ? "🖼" : "📎"} {a.name}
						</span>
					))}
				</div>
			)}
			<div
				ref={contentRef}
				className={styles.bubbleText}
				data-clamped={overflows && !expanded ? "" : undefined}
				style={overflows && !expanded ? { maxHeight: CLAMP_PX } : undefined}
			>
				{text}
			</div>
			{overflows && (
				<button className={styles.showMore} onClick={() => setExpanded((e) => !e)}>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</div>
	);
}
const CLAMP_PX = 80;

// Memoized: with stable callbacks and ref-stable item objects (only changed
// items get new refs from the reducer), a streamed token re-renders just the
// message that changed — not the whole history.
const ChatRow = memo(function ChatRow({
	item,
	pinned,
	onPermission,
	onElicit,
}: {
	item: ChatItem;
	/** Pin this user row as the turn's sticky header. */
	pinned?: boolean;
	onPermission: (id: string, optionId: string, label: string) => void;
	onElicit: (
		id: string,
		action: "accept" | "decline" | "cancel",
		content?: Record<string, ElicitationValue>,
	) => void;
}) {
	if (item.kind === "user") {
		return (
			<div className={styles.user} data-pinned={pinned || undefined}>
				<UserBubble
					text={item.text}
					attachments={item.attachments}
					title={item.ts ? clockTime(item.ts) : undefined}
				/>
			</div>
		);
	}
	if (item.kind === "assistant") {
		// A text-less agent update (only blank lines / `---` rules) would render as a
		// stack of empty horizontal rules — skip it rather than show the noise.
		if (isBlankText(item.text)) return null;
		return (
			<div className={styles.assistant} title={item.ts ? clockTime(item.ts) : undefined}>
				<Markdown text={item.text} />
			</div>
		);
	}
	if (item.kind === "thinking") {
		if (isBlankText(item.text)) return null;
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
});

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
/** True when text has no visible markdown content — only blank lines and horizontal rules. */
function isBlankText(text: string): boolean {
	return text.split("\n").every((l) => /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})?[ \t]*$/.test(l));
}

function describeInput(input: unknown): string {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		const primary = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern;
		if (typeof primary === "string") return primary;
	}
	const s = typeof input === "string" ? input : JSON.stringify(input ?? {});
	return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
