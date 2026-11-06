import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	AgentChatEvent,
	AgentMode,
	AgentPermissionMode,
	AgentProvider,
	ChatAttachment,
	ChatDiff,
	ConfigOption,
	ElicitationField,
	ElicitationValue,
	PermissionOption,
	PlanEntryStatus,
} from "../../shared/types";
import { api, bus, subscribeAgentChat } from "../rpc";
import { getSession, markExited, openDiff, openSession, updateSession } from "../lib/terminalStore";
import { notify } from "../lib/toast";
import { Dropdown, DropdownItem } from "./Dropdown";
import { AgentDiff } from "./AgentDiff";
import { FOREST_WORDS, nextForestWord } from "../lib/forestWords";
import {
	PERMISSION_MODES,
	coerceModel,
	coerceProvider,
	getChatConfig,
	modelArg,
	providerLabel,
	rememberProviderModes,
	rememberProviderModels,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { Markdown } from "./Markdown";
import { clockTime, relativeTime, timeDivider } from "../lib/format";
import { ChevronDownIcon, CloseIcon, CopyIcon, EllipsisIcon, GitBranchIcon, PlusIcon } from "./icons";
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
	| {
			kind: "user";
			text: string;
			attachments?: { name: string; isImage: boolean }[];
			ts?: number;
			/** Added to a running turn (steered in), not sent as a new turn. */
			steered?: boolean;
	  }
	| { kind: "assistant"; text: string; ts?: number; messageId?: string }
	| { kind: "thinking"; text: string }
	| {
			kind: "tool";
			id: string;
			name: string;
			input: unknown;
			status: "running" | "ok" | "error";
			summary?: string;
			/** Structured file edits (edit/write tools) — rendered as a real diff. */
			diffs?: ChatDiff[];
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
	projectId,
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
	projectId: string;
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
	// Context use from the agent, and whether to suggest starting fresh on reopen.
	const [usage, setUsage] = useState<Usage | null>(null);
	const [freshBanner, setFreshBanner] = useState(false);
	const lastUsageRef = useRef<Usage | null>(null);
	const lastEventTs = useRef(0);
	// Open an agent edit as a full Monaco side-by-side diff (working tree vs HEAD for
	// that file — the applied change), reusing the app's diff-tab infra.
	const openEditDiff = useCallback(
		(path: string) => void openDiff({ worktreeId, projectId, path, base: null, preview: true }),
		[worktreeId, projectId],
	);
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
		setUsage(null);
		setFreshBanner(false);
		lastUsageRef.current = null;
		lastEventTs.current = 0;

		function apply(event: AgentChatEvent) {
			if (event.ts) lastEventTs.current = Math.max(lastEventTs.current, event.ts);
			switch (event.type) {
				case "usage": {
					const u = { used: event.used, size: event.size, cost: event.cost };
					lastUsageRef.current = u;
					setUsage(u);
					break;
				}
				case "history":
					// The full buffer on (re)attach: start from a clean transcript (so
					// overlapping replays can't stack into duplicates), then apply it all
					// synchronously — React batches the lot into a single render.
					setItems([]);
					setPlan([]);
					for (const e of event.events) apply(e);
					// Back to a big chat after its prompt cache has gone cold: continuing
					// re-reads the whole context, so offer to start fresh instead.
					{
						const u = lastUsageRef.current;
						const idle = Date.now() - lastEventTs.current;
						if (u && u.used >= BIG_CONTEXT && lastEventTs.current && idle > CACHE_COLD_MS) {
							setFreshBanner(true);
						}
					}
					break;
				case "system":
					setStatus((s) => (s === "starting" || s === "ended" ? "idle" : s));
					break;
				case "user_text":
					setItems((it) => [
						...it,
						{ kind: "user", text: event.text, attachments: event.attachments, ts: event.ts, steered: event.steered },
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
					setItems((it) => mergeText(it, "assistant", event.text, event.ts, event.messageId));
					break;
				case "thinking":
					setStatus("working");
					setItems((it) => mergeText(it, "thinking", event.text, event.ts));
					break;
				case "tool_use":
					setItems((it) => [
						...it,
						{ kind: "tool", id: event.id, name: event.name, input: event.input, status: "running", diffs: event.diffs },
					]);
					break;
				case "tool_result":
					setItems((it) =>
						it.map((x) =>
							x.kind === "tool" && x.id === event.id
								? // keep the diff from tool_use if the completion didn't repeat it
								  { ...x, status: event.ok ? "ok" : "error", summary: event.summary, diffs: event.diffs ?? x.diffs }
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
					// The agent quit on its own (e.g. its own idle exit). Not terminal: the
					// next message starts a fresh one and resumes the conversation.
					setStatus("idle");
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
				// Applied by main when the agent actually starts (restored chats start on
				// first use, so the view can't tell when that is).
				defaultMode: getChatConfig().defaultModeByProvider?.[coerceProvider(provider)] ?? null,
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
	// Most recent turns rendered (older ones load as you scroll up; see below).
	const [turnLimit, setTurnLimit] = useState(TURN_WINDOW);
	const restoringScroll = useRef(false);
	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		// Our own offset restore after loading older turns isn't the user returning.
		if (restoringScroll.current) {
			restoringScroll.current = false;
			return;
		}
		// Back at the bottom following along: drop the older turns you'd loaded (UI
		// only — they reload on the next scroll up). Only when the content is well over
		// a screen tall, so a short chat can't trim → reveal the sentinel → reload in a
		// loop. Bails out when unchanged.
		if (stick.current && el.scrollHeight > el.clientHeight * 3) {
			setTurnLimit((n) => (n > TURN_WINDOW ? TURN_WINDOW : n));
		}
	};
	// `active` is a dep because a tab mounted while hidden (display:none) measures
	// zero height — re-run on activation so the newest message is in view.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && active && stick.current) el.scrollTop = el.scrollHeight;
	}, [items, status, active, turnLimit]);

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

	// Learn this provider's model and mode options, so pickers and Settings can offer
	// them before an agent is connected. (The default mode itself is applied by main
	// when an agent actually starts — see defaultMode in agentChatStart.)
	useEffect(() => {
		// Remember the agent's own model list so pickers (before connect, new chats)
		// offer its real, current models — no app change needed when models ship.
		const modelOpt = configOptions.find((o) => o.id === "model" || o.category === "model");
		if (modelOpt) {
			rememberProviderModels(
				providerValue,
				modelOpt.options.map((o) => ({ value: o.value, label: o.label })),
			);
		}
		const modeOpt = configOptions.find((o) => o.id === "mode" || o.category === "mode");
		if (!modeOpt) return;
		rememberProviderModes(
			providerValue,
			modeOpt.options.map((o) => ({ value: o.value, label: o.label })),
		);
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
	// We cancel and move it to the front, and the drain-on-idle effect sends it once
	// the cancelled turn ends. Agents don't always report the end of a cancelled turn
	// (steering a second time often left it stuck "working"), so if nothing arrives
	// within STEER_GRACE_MS, treat the turn as over and send — what Stop + send does.
	const steerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Fallback for agents that can't steer: stop the turn, then send this. */
	function interruptAndSend(item: Outgoing) {
		setQueue((q) => [item, ...q]);
		bus.agentChatCancel({ sessionId: chatId });
		if (steerTimer.current) clearTimeout(steerTimer.current);
		steerTimer.current = setTimeout(() => {
			steerTimer.current = null;
			setStatus((s) => (s === "working" ? "idle" : s));
		}, STEER_GRACE_MS);
	}
	// The turn ended on its own (or we left) — the safety net isn't needed.
	useEffect(() => {
		if (status !== "working" && steerTimer.current) {
			clearTimeout(steerTimer.current);
			steerTimer.current = null;
		}
	}, [status]);
	useEffect(() => () => {
		if (steerTimer.current) clearTimeout(steerTimer.current);
	}, []);

	/**
	 * Steer now: add the message to the running turn — the agent takes it at its
	 * next step and keeps going (nothing cancelled). If nothing is running it's just
	 * sent; if this agent can't steer, fall back to interrupt-and-send (and say so).
	 */
	async function steerNow(item: Outgoing) {
		stick.current = true;
		const { result } = await api.agentChatSteer({
			sessionId: chatId,
			text: item.text,
			attachments: item.attachments,
		});
		if (result === "unsupported") {
			notify("This agent can't take messages mid-turn — stopped it and sent yours instead.");
			interruptAndSend(item);
		}
	}
	/** Steer a message waiting in the queue. */
	function steerQueued(index: number) {
		const item = queue[index];
		if (!item) return;
		setQueue((q) => q.filter((_, i) => i !== index));
		void steerNow(item);
	}
	/** Steer what's in the composer (⌘↩ / the Send menu) — while working; else send. */
	function steerComposer() {
		if (!working) return submit();
		const text = input.trim();
		const atts: ChatAttachment[] = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
		if (!text && atts.length === 0) return;
		setInput("");
		setAttachments([]);
		void steerNow({ text, attachments: atts });
	}

	/** Take a queued (or steered, not yet sent) message back: drop it from the queue
	 *  and return its text and attachments to the composer so nothing is lost. */
	function unqueue(index: number) {
		const item = queue[index];
		if (!item) return;
		setQueue((q) => q.filter((_, i) => i !== index));
		if (item.text) setInput((v) => (v.trim() ? `${item.text}\n\n${v}` : item.text));
		if (item.attachments.length) {
			setAttachments((a) => [
				...item.attachments.map((x) => ({
					id: crypto.randomUUID(),
					name: x.name,
					mediaType: x.mediaType,
					data: x.data,
					dataUrl: `data:${x.mediaType};base64,${x.data}`,
					isImage: x.mediaType.startsWith("image/"),
				})),
				...a,
			]);
		}
	}
	/**
	 * Start fresh: a new chat in this worktree, optionally carrying the last `lastN`
	 * messages (prose only — no tool output — and capped) as its first message, so
	 * the new agent has recent context without the whole history.
	 */
	function startFresh(lastN: number) {
		const src = getSession(dockId);
		const recent = items
			.filter((i): i is Extract<ChatItem, { kind: "user" | "assistant" }> => i.kind === "user" || i.kind === "assistant")
			.slice(-lastN);
		setFreshBanner(false);
		openSession({
			worktreeId,
			projectId,
			kind: "chat",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: crypto.randomUUID(),
			provider: providerValue,
			permissionMode: mode,
			model: modelValue,
			agentLabel: src?.agentLabel,
			name: "New chat",
			title: src?.title ?? "Chat",
			initialPrompt: lastN > 0 && recent.length > 0 ? carryOverPrompt(recent) : undefined,
		});
	}

	// Branch the chat at an agent message: fork the agent session there and open the
	// result as a new chat tab (same context up to that message, then diverges).
	const branchFrom = useCallback(
		async (messageId: string) => {
			const newId = crypto.randomUUID();
			const res = await api.agentChatFork({ sessionId: chatId, newSessionId: newId, messageId });
			if (!res.ok) {
				notify(res.error ?? "Couldn't branch this chat", "error");
				return;
			}
			const src = getSession(dockId);
			openSession({
				worktreeId,
				projectId,
				kind: "chat",
				commandId: null,
				command: null,
				resumeCommand: null,
				sessionId: newId,
				resume: true, // seeded with the history up to the branch point; resumes the fork
				provider: providerValue,
				permissionMode: mode,
				model: modelValue,
				agentLabel: src?.agentLabel,
				name: `⑂ ${src?.name ?? "Branch"}`,
				renamed: true,
				title: src?.title ?? "Branch",
			});
		},
		[chatId, dockId, worktreeId, projectId, providerValue, mode, modelValue],
	);
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
	// ↩ sends (queues while working); ⌘↩ / Ctrl↩ steers into the running turn.
	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (e.metaKey || e.ctrlKey) steerComposer();
			else submit();
		}
	}

	// Rebuilt only when items change (not on every keystroke/config re-render).
	const renderNodes = useMemo(() => buildRenderNodes(items), [items]);
	// Group nodes into turns: each starts at a new question (a user cluster) and runs
	// through its answer. Wrapping a turn constrains its sticky question header to that
	// turn's box, so the next turn scrolls up and *pushes* the previous header out.
	const sections = useMemo(() => buildSections(renderNodes), [renderNodes]);
	const dividers = useMemo(() => buildDividers(sections), [sections]);
	// Render only the most recent turns (bounds the DOM of long chats, which stay
	// mounted while their tab is hidden). A sentinel above them loads another window
	// as you scroll near the top; the scroll offset is then restored so the view
	// doesn't jump as older turns appear above it.
	const hiddenTurns = Math.max(0, sections.length - turnLimit);
	const topSentinel = useRef<HTMLDivElement>(null);
	const loadAnchor = useRef<{ height: number; top: number } | null>(null);
	useEffect(() => {
		const el = topSentinel.current;
		const root = scrollRef.current;
		if (!el || !root) return;
		// Re-created per load, so a sentinel still in view after a short load fires again.
		const io = new IntersectionObserver(
			([entry]) => {
				if (!entry.isIntersecting) return;
				loadAnchor.current = { height: root.scrollHeight, top: root.scrollTop };
				setTurnLimit((n) => n + TURN_WINDOW);
			},
			{ root, rootMargin: "400px 0px 0px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [hiddenTurns > 0, turnLimit]);
	useLayoutEffect(() => {
		const root = scrollRef.current;
		const a = loadAnchor.current;
		if (!root || !a) return;
		loadAnchor.current = null;
		restoringScroll.current = true;
		root.scrollTop = a.top + (root.scrollHeight - a.height);
	}, [turnLimit]);
	const lastNode = renderNodes[renderNodes.length - 1];

	// ⌘F: find in this chat's whole history (prose only — tool output isn't searched).
	// Matching runs over all turns, so a hit in an unloaded turn widens the window to
	// it; the matched text is painted with the CSS Custom Highlight API.
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findPos, setFindPos] = useState(0); // index into findHits
	const findRef = useRef<HTMLInputElement>(null);
	const q = findQuery.trim().toLowerCase();
	const findHits = useMemo(
		() => (q ? sections.flatMap((sec, i) => (sectionText(sec).includes(q) ? [i] : [])) : []),
		[sections, q],
	);
	// A new query starts at the newest match.
	useEffect(() => setFindPos(findHits.length - 1), [q]); // eslint-disable-line react-hooks/exhaustive-deps
	const pos = Math.min(findPos, findHits.length - 1);
	const findTurn = findHits[pos];
	// Scroll once per jump (not on every later window change, so you can scroll away).
	const pendingJump = useRef(false);
	useEffect(() => {
		pendingJump.current = true;
		if (findTurn !== undefined) setTurnLimit((n) => Math.max(n, sections.length - findTurn));
	}, [findTurn, q]); // eslint-disable-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		if (!findOpen || findTurn === undefined || !pendingJump.current) return;
		const el = scrollRef.current?.querySelector(`[data-turn="${findTurn}"]`);
		if (!el) return;
		pendingJump.current = false;
		stick.current = false;
		const range = textRanges(el, q)[0];
		(range?.startContainer.parentElement ?? el).scrollIntoView({ block: "center" });
	}, [findOpen, findTurn, turnLimit, q]);
	useEffect(() => {
		const root = scrollRef.current;
		if (!findOpen || !active || !q || !root || typeof Highlight === "undefined") return;
		CSS.highlights.set("chat-find", new Highlight(...textRanges(root, q)));
		const cur = root.querySelector(`[data-turn="${findTurn}"]`);
		const first = cur ? textRanges(cur, q)[0] : undefined;
		if (first) CSS.highlights.set("chat-find-current", new Highlight(first));
		return () => {
			CSS.highlights.delete("chat-find");
			CSS.highlights.delete("chat-find-current");
		};
	}, [findOpen, active, q, findTurn, turnLimit, items]);
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
				e.preventDefault();
				pendingJump.current = true;
				setFindOpen(true);
				requestAnimationFrame(() => findRef.current?.select());
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);
	const stepFind = (dir: 1 | -1) =>
		findHits.length && setFindPos((pos + dir + findHits.length) % findHits.length);
	const closeFind = () => {
		setFindOpen(false);
		inputRef.current?.focus();
	};

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
			{findOpen && (
				<div className={styles.findBar}>
					<input
						ref={findRef}
						autoFocus
						className={styles.findInput}
						placeholder="Find in chat"
						value={findQuery}
						onChange={(e) => setFindQuery(e.target.value)}
						onKeyDown={(e) => {
							// Enter walks back through history (older), ⇧Enter forward.
							if (e.key === "Enter") stepFind(e.shiftKey ? 1 : -1);
							else if (e.key === "Escape") closeFind();
						}}
					/>
					<span className={styles.findCount}>
						{q ? (findHits.length ? `${pos + 1} / ${findHits.length}` : "No matches") : ""}
					</span>
					<button className={styles.findBtn} onClick={() => stepFind(-1)} title="Older match (Enter)" aria-label="Older match">
						↑
					</button>
					<button className={styles.findBtn} onClick={() => stepFind(1)} title="Newer match (⇧Enter)" aria-label="Newer match">
						↓
					</button>
					<button className={styles.findBtn} onClick={closeFind} title="Close (Esc)" aria-label="Close find">
						<CloseIcon size={12} />
					</button>
				</div>
			)}
			<div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
				{items.length === 0 && status !== "starting" && (
					<div className={styles.empty}>Send a message to start the conversation.</div>
				)}
				{hiddenTurns > 0 && (
					<div ref={topSentinel} className={styles.earlier}>
						{hiddenTurns} earlier turn{hiddenTurns === 1 ? "" : "s"}
					</div>
				)}
				{sections.slice(hiddenTurns).map((sec, i) => (
					<div key={i + hiddenTurns} className={styles.turn} data-turn={i + hiddenTurns}>
						{dividers[i + hiddenTurns] && (
							<div className={styles.timeDivider}>
								<span>{dividers[i + hiddenTurns]}</span>
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
									onOpenDiff={openEditDiff}
								/>
							) : (
								<ChatRow
									key={ni}
									item={node}
									pinned={ni === sec.headerIdx}
									onPermission={respondPermission}
									onElicit={submitElicit}
									onOpenDiff={openEditDiff}
									onBranch={branchFrom}
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
							<div className={styles.queuedActions}>
								{working && (
									<button
										className={styles.steer}
										onClick={() => steerQueued(i)}
										title="Add to the running turn now — the agent picks it up at its next step and keeps working"
									>
										Steer now
									</button>
								)}
								<button
									className={styles.steer}
									onClick={() => unqueue(i)}
									title="Don't send — put it back in the message box"
								>
									Cancel
								</button>
							</div>
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

			{freshBanner && usage && (
				<div className={styles.freshBanner}>
					<span>
						This chat is {fmtTokens(usage.used)} tokens and was last used{" "}
						{relativeTime(lastEventTs.current)} — continuing re-reads all of it.
					</span>
					<Dropdown trigger={<button className={styles.freshBtn}>Start fresh ▾</button>}>
						<StartFreshItems onPick={startFresh} />
					</Dropdown>
					<button className={styles.freshDismiss} onClick={() => setFreshBanner(false)}>
						Continue here
					</button>
				</div>
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
					{usage && (
						<Dropdown
							trigger={
								<button
									className={styles.meter}
									data-big={usage.used >= BIG_CONTEXT || undefined}
									title="Context this chat sends with every message — click to start fresh"
								>
									{fmtTokens(usage.used)} / {fmtTokens(usage.size)}
									{usage.cost ? ` · ${fmtCost(usage.cost)}` : ""}
								</button>
							}
						>
							<StartFreshItems onPick={startFresh} />
						</Dropdown>
					)}
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
					) : working ? (
						// While a turn runs: ↩ queues it for after the turn; ⌘↩ steers it in.
						<div className={styles.sendSplit}>
							<button
								className={styles.send}
								onClick={submit}
								disabled={!canSend}
								title="Send after this turn finishes (↩)"
							>
								Queue
							</button>
							<Dropdown
								trigger={
									<button className={styles.sendMore} disabled={!canSend} aria-label="More send options">
										<ChevronDownIcon size={13} />
									</button>
								}
							>
								<DropdownItem
									label="Queue — send after this turn"
									hint="↩"
									onClick={submit}
								/>
								<DropdownItem
									label="Steer now — agent takes it at its next step"
									hint="⌘↩"
									onClick={steerComposer}
								/>
							</Dropdown>
						</div>
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
	messageId?: string,
): ChatItem[] {
	const last = items[items.length - 1];
	if (last && last.kind === kind) {
		// Keep the newest message id: branching from this bubble includes all of it.
		return [...items.slice(0, -1), { ...last, text: last.text + text, ...(messageId ? { messageId } : {}) }];
	}
	// ts only on the first chunk — it's when the turn's answer began.
	return [...items, kind === "assistant" ? { kind, text, ts, messageId } : { kind, text }];
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
/** Open state for a <details> whose body mounts only while open. Collapsed step
 *  strips, tool output (parsed Markdown, up to 4k chars each) and thinking are most
 *  of a long agentic chat's DOM, and are rarely expanded. */
function useFold(initial = false) {
	const [open, setOpen] = useState(initial);
	return {
		open,
		onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open),
	};
}

function ProcessStrip({
	steps,
	active = false,
	onPermission,
	onElicit,
	onOpenDiff,
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
	onOpenDiff: (path: string) => void;
}) {
	const last = steps[steps.length - 1];
	const hint = last ? stepHint(last) : "";
	const fold = useFold();
	return (
		<details className={styles.process} data-active={active || undefined} open={fold.open} onToggle={fold.onToggle}>
			<summary className={styles.processHead}>
				{/* No "Working…" verb — the tree + forest word is the single live status;
				    this strip just labels the tool steps it folds (dot pulses while active). */}
				<span className={styles.processSpinner} />
				<span className={styles.processTitle}>
					{steps.length} step{steps.length === 1 ? "" : "s"}
				</span>
				{hint && <span className={styles.processMeta}>· {hint}</span>}
			</summary>
			{fold.open && (
				<div className={styles.processBody}>
					{steps.map((s, i) => (
						<ChatRow key={i} item={s} onPermission={onPermission} onElicit={onElicit} onOpenDiff={onOpenDiff} />
					))}
				</div>
			)}
		</details>
	);
}

// http(s) URLs in plain text. Trailing sentence punctuation / a closing bracket is
// left out of the link ("see https://x.com/a." links just the URL).
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRAIL = /[.,;:!?)\]}'"]+$/;

/** Plain text with its URLs turned into links that open in the browser. The rest
 *  stays literal (a user's message isn't reinterpreted as Markdown). */
function linkify(text: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(URL_RE)) {
		const url = m[0].replace(URL_TRAIL, "");
		const start = m.index;
		if (start > last) out.push(text.slice(last, start));
		out.push(
			<a
				key={start}
				className={styles.bubbleLink}
				href={url}
				onClick={(e) => {
					e.preventDefault();
					api.openUrl({ url });
				}}
			>
				{url}
			</a>,
		);
		last = start + url.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
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
				{linkify(text)}
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
type Usage = { used: number; size: number; cost?: { amount: number; currency: string } };
/** Context size (tokens) past which the meter highlights and reopening suggests a
 *  fresh start: every message re-sends this much. */
const BIG_CONTEXT = 150_000;
/** After this long idle the prompt cache is gone, so continuing re-reads it all. */
const CACHE_COLD_MS = 60 * 60_000;

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}
function fmtCost(c: { amount: number; currency: string }): string {
	return c.currency === "USD" ? `$${c.amount.toFixed(2)}` : `${c.amount.toFixed(2)} ${c.currency}`;
}

/** The Start fresh choices: empty, or carrying the last few messages. */
function StartFreshItems({ onPick }: { onPick: (lastN: number) => void }) {
	return (
		<>
			<DropdownItem label="Start fresh — empty chat" onClick={() => onPick(0)} />
			{[3, 5, 10].map((n) => (
				<DropdownItem key={n} label={`Start fresh with the last ${n} messages`} onClick={() => onPick(n)} />
			))}
		</>
	);
}

/** First message of a fresh chat that carries recent messages over (prose only, capped). */
/** A turn's searchable text (questions and answers, lowercased). */
function sectionText(sec: Section): string {
	const parts: string[] = [];
	for (const node of sec.nodes) {
		if (node.kind === "user" || node.kind === "assistant") parts.push(node.text);
		else if (node.kind === "process")
			for (const st of node.steps) if (st.kind === "assistant") parts.push(st.text);
	}
	return parts.join("\n").toLowerCase();
}

/** DOM ranges of every (case-insensitive) occurrence of `q` in `root`'s text. */
function textRanges(root: Node, q: string): Range[] {
	const ranges: Range[] = [];
	const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walk.nextNode(); n; n = walk.nextNode()) {
		const text = n.nodeValue?.toLowerCase() ?? "";
		for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
			const r = document.createRange();
			r.setStart(n, i);
			r.setEnd(n, i + q.length);
			ranges.push(r);
		}
	}
	return ranges;
}

function carryOverPrompt(msgs: { kind: "user" | "assistant"; text: string }[]): string {
	const MAX_EACH = 2000;
	const MAX_TOTAL = 12_000;
	const clip = (t: string) => (t.length > MAX_EACH ? `${t.slice(0, MAX_EACH)}…` : t);
	let body = msgs.map((m) => `${m.kind === "user" ? "Me" : "You"}: ${clip(m.text.trim())}`).join("\n\n");
	if (body.length > MAX_TOTAL) body = `…${body.slice(-MAX_TOTAL)}`;
	return (
		`Carrying over the last ${msgs.length} messages from an earlier chat in this worktree, for context:\n\n` +
		`---\n${body}\n---\n\n` +
		"Treat this as background. Reply with one short line saying you're ready, then wait for my next message."
	);
}

/** How long a steer waits for the cancelled turn to end before sending anyway. */
const STEER_GRACE_MS = 3000;
/** Turns rendered at once in a chat; scrolling up loads this many more at a time. */
const TURN_WINDOW = 30;

// Memoized: with stable callbacks and ref-stable item objects (only changed
// items get new refs from the reducer), a streamed token re-renders just the
// message that changed — not the whole history.
const ChatRow = memo(function ChatRow({
	item,
	pinned,
	onPermission,
	onElicit,
	onOpenDiff,
	onBranch,
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
	onOpenDiff: (path: string) => void;
	/** Branch the chat at this agent message (main transcript only). */
	onBranch?: (messageId: string) => void;
}) {
	const fold = useFold();
	if (item.kind === "user") {
		return (
			<div className={styles.user} data-pinned={pinned || undefined} data-steered={item.steered || undefined}>
				{item.steered && (
					<span
						className={styles.steeredTag}
						title="Added to the running turn — the agent picked it up at its next step"
					>
						steered in
					</span>
				)}
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
				{item.messageId && onBranch && (
					<div className={styles.msgMenu}>
						<Dropdown
							trigger={
								<button className={styles.msgMenuBtn} aria-label="Message actions" title="Message actions">
									<EllipsisIcon size={14} />
								</button>
							}
						>
							<DropdownItem
								icon={<GitBranchIcon size={15} />}
								label="Branch from here"
								onClick={() => onBranch(item.messageId!)}
							/>
							<DropdownItem
								icon={<CopyIcon size={15} />}
								label="Copy text"
								onClick={() => void navigator.clipboard.writeText(item.text)}
							/>
						</Dropdown>
					</div>
				)}
			</div>
		);
	}
	if (item.kind === "thinking") {
		if (isBlankText(item.text)) return null;
		return (
			<details className={styles.thinking} open={fold.open} onToggle={fold.onToggle}>
				<summary>Thinking</summary>
				{fold.open && <div className={styles.thinkingBody}>{item.text}</div>}
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
	// A file edit: show a real inline diff (open by default) with a "View diff"
	// action, instead of the flattened text.
	if (item.diffs && item.diffs.length > 0) {
		return (
			<details className={styles.tool} data-status={item.status} open>
				<summary className={styles.toolHeader}>
					<span className={styles.toolDot} />
					<span className={styles.toolName}>{item.name}</span>
				</summary>
				<div className={styles.toolBody}>
					<AgentDiff diffs={item.diffs} onOpen={onOpenDiff} />
				</div>
			</details>
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
		<details className={styles.tool} data-status={item.status} open={fold.open} onToggle={fold.onToggle}>
			<summary className={styles.toolHeader}>
				<span className={styles.toolDot} />
				<span className={styles.toolName}>{item.name}</span>
				<span className={styles.toolSummary}>{toolPreview(item.summary)}</span>
			</summary>
			{fold.open && (
				<div className={styles.toolBody}>
					<Markdown text={item.summary} />
				</div>
			)}
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
