import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	closeSession,
	getRestorableSessions,
	moveTab,
	reopenSessions,
	resizePane,
	sessionKey,
	setActiveSession,
	splitTab,
	updateSession,
	useTerminals,
	type TermSession,
} from "../lib/terminalStore";
import {
	dropDirAt,
	reconcile,
	type DropDir,
	type PaneGroup,
	type PaneNode,
} from "../lib/paneLayout";
import { bus } from "../rpc";
import { TerminalPane } from "./TerminalPane";
import { ChatPane } from "./ChatPane";
import { DiffView } from "./DiffView";
import { CloseIcon, FileIcon, SparkleIcon, TerminalIcon } from "./icons";
import styles from "./SessionWorkspace.module.css";

/** Stop a session's process (explicit close) and drop the tab. */
function endSession(s: TermSession) {
	if (s.kind === "chat") bus.agentChatStop({ sessionId: s.sessionId ?? s.id });
	else if (s.kind === "terminal") bus.termKill({ sessionId: s.id });
	// diff tabs have no process — just drop them.
	closeSession(s.id);
}

/** Shared handlers/state threaded through the recursive pane tree. */
type Ctx = {
	worktreeId: string;
	/** Sessions of this worktree by their stable pane key (the layout's tab ids). */
	byKey: Map<string, TermSession>;
	activeId: string | null;
	dragging: string | null;
	setDragging: (id: string | null) => void;
	editingId: string | null;
	startRename: (s: TermSession) => void;
	draftName: string;
	setDraftName: (v: string) => void;
	commitRename: () => void;
	cancelRename: () => void;
};
const PaneCtx = createContext<Ctx | null>(null);
const usePane = () => useContext(PaneCtx)!;

/**
 * The center workspace for a worktree: a tiling tree of its sessions. Each leaf is
 * a tab group showing its active tab; groups can be split side-by-side or stacked
 * by dragging a tab to a group's edge (drag onto the strip/center to move it in).
 * New sessions are launched from the worktree toolbar (WorktreeView).
 */
export function SessionWorkspace({ worktreeId }: { worktreeId: string }) {
	const { sessions, activeId, layouts } = useTerminals();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const [dragging, setDragging] = useState<string | null>(null);

	const visible = sessions.filter((s) => s.worktreeId === worktreeId);
	const keys = visible.map(sessionKey);
	const layout = useMemo(
		() => reconcile(layouts[worktreeId], keys),
		// join is enough — the tree only changes with the stored layout or the key set
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[layouts[worktreeId], keys.join("|")],
	);
	const byKey = useMemo(() => new Map(visible.map((s) => [sessionKey(s), s] as const)), [visible]);

	useEffect(() => {
		if (visible.length > 0 && !visible.some((s) => s.id === activeId)) {
			setActiveSession(visible[0].id);
		}
	}, [visible, activeId]);

	// Reopen everything that was open for this worktree last time — chats resume by
	// their session id; terminals relaunch (a fresh pty, since the old one died with
	// the app). See terminalStore.
	useEffect(() => {
		const toReopen = getRestorableSessions(worktreeId).filter(
			(r) => r.kind === "terminal" || r.sessionId,
		);
		if (toReopen.length) reopenSessions(toReopen);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [worktreeId]);

	function startRename(s: TermSession) {
		setEditingId(s.id);
		setDraftName(s.name ?? tabLabel(s));
	}
	function commitRename() {
		if (editingId) {
			const name = draftName.trim();
			if (name) updateSession(editingId, { name, renamed: true });
		}
		setEditingId(null);
	}

	if (visible.length === 0) {
		return (
			<div className={styles.workspace}>
				<div className={styles.empty}>
					<p>No sessions in this worktree yet.</p>
					<p className={styles.emptyHint}>Start a chat or terminal from the toolbar above.</p>
				</div>
			</div>
		);
	}

	const ctx: Ctx = {
		worktreeId,
		byKey,
		activeId,
		dragging,
		setDragging,
		editingId,
		startRename,
		draftName,
		setDraftName,
		commitRename,
		cancelRename: () => setEditingId(null),
	};

	return (
		<div className={styles.workspace}>
			<PaneCtx.Provider value={ctx}>
				<PaneTree node={layout} />
			</PaneCtx.Provider>
		</div>
	);
}

function PaneTree({ node }: { node: PaneNode }) {
	return node.kind === "split" ? <SplitView node={node} /> : <GroupView node={node} />;
}

function SplitView({ node }: { node: Extract<PaneNode, { kind: "split" }> }) {
	const { worktreeId } = usePane();
	const ref = useRef<HTMLDivElement>(null);

	function startResize(i: number, e: React.MouseEvent) {
		e.preventDefault();
		const cont = ref.current;
		if (!cont) return;
		const rect = cont.getBoundingClientRect();
		const total = node.dir === "row" ? rect.width : rect.height;
		const origin = node.dir === "row" ? e.clientX : e.clientY;
		const s0 = node.sizes.slice();
		const pair = s0[i] + s0[i + 1];
		const move = (ev: MouseEvent) => {
			const cur = node.dir === "row" ? ev.clientX : ev.clientY;
			const df = (cur - origin) / total;
			const a = Math.max(0.1, Math.min(s0[i] + df, pair - 0.1));
			const next = s0.slice();
			next[i] = a;
			next[i + 1] = pair - a;
			resizePane(worktreeId, node.id, next);
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	return (
		<div ref={ref} className={node.dir === "row" ? styles.splitRow : styles.splitCol}>
			{node.children.map((c, i) => (
				<Fragment key={c.id}>
					{i > 0 && (
						<div
							className={node.dir === "row" ? styles.resizerV : styles.resizerH}
							onMouseDown={(e) => startResize(i - 1, e)}
						/>
					)}
					<div className={styles.cell} style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
						<PaneTree node={c} />
					</div>
				</Fragment>
			))}
		</div>
	);
}

function GroupView({ node }: { node: PaneGroup }) {
	const c = usePane();
	const [over, setOver] = useState<DropDir | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	function onBodyDragOver(e: React.DragEvent) {
		if (!c.dragging) return;
		e.preventDefault();
		const r = bodyRef.current?.getBoundingClientRect();
		if (r) setOver(dropDirAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height));
	}
	function onBodyDrop(e: React.DragEvent) {
		if (!c.dragging) return;
		e.preventDefault();
		const tab = c.dragging;
		const dir = over;
		setOver(null);
		c.setDragging(null);
		if (!dir || dir === "center") moveTab(c.worktreeId, tab, node.id);
		else if (dir === "left") splitTab(c.worktreeId, tab, node.id, "row", true);
		else if (dir === "right") splitTab(c.worktreeId, tab, node.id, "row", false);
		else if (dir === "top") splitTab(c.worktreeId, tab, node.id, "col", true);
		else splitTab(c.worktreeId, tab, node.id, "col", false);
	}

	// Focus this group on any interaction (clicking into a pane body, not just its
	// tab), so a new chat/terminal from the toolbar opens here — the pane you're in.
	function focusGroup() {
		const s = node.active ? c.byKey.get(node.active) : undefined;
		if (s && s.id !== c.activeId) setActiveSession(s.id);
	}

	return (
		<div className={styles.paneGroup} onMouseDownCapture={focusGroup} onFocusCapture={focusGroup}>
			<div
				className={styles.tabs}
				onDragOver={(e) => c.dragging && e.preventDefault()}
				onDrop={(e) => {
					if (!c.dragging) return;
					e.preventDefault();
					const tab = c.dragging;
					c.setDragging(null);
					moveTab(c.worktreeId, tab, node.id);
				}}
			>
				{node.tabs.map((key, i) => {
					const s = c.byKey.get(key);
					return s ? (
						<Tab key={key} session={s} paneKey={key} groupId={node.id} index={i} active={key === node.active} />
					) : null;
				})}
			</div>
			<div className={styles.body} ref={bodyRef}>
				{node.tabs.map((key) => {
					const s = c.byKey.get(key);
					if (!s) return null;
					return (
						<div key={key} className={styles.pane} style={{ display: key === node.active ? "block" : "none" }}>
							{s.kind === "chat" ? (
								<ChatPane
									dockId={s.id}
									chatId={s.sessionId ?? s.id}
									worktreeId={s.worktreeId}
									provider={s.provider ?? "claude"}
									resume={s.resume ?? false}
									permissionMode={s.permissionMode ?? "default"}
									model={s.model ?? null}
									agentLabel={s.agentLabel}
									renamed={s.renamed}
									initialPrompt={s.initialPrompt}
									active={key === node.active}
								/>
							) : s.kind === "terminal" ? (
								<TerminalPane
									sessionId={s.id}
									worktreeId={s.worktreeId}
									commandId={s.commandId}
									command={s.command}
								/>
							) : s.diff ? (
								<DiffView
									worktreeId={s.worktreeId}
									path={s.diff.path}
									base={s.diff.base}
									commit={s.diff.commit}
								/>
							) : null}
						</div>
					);
				})}
				{/* While a tab is dragging, an overlay above the panes catches the drop so
				    it never reaches ChatPane's own file-drop handlers. */}
				{c.dragging && (
					<div
						className={styles.dropCatch}
						onDragOver={onBodyDragOver}
						onDrop={onBodyDrop}
						onDragLeave={() => setOver(null)}
					>
						{over && <div className={styles.dropHint} data-dir={over} />}
					</div>
				)}
			</div>
		</div>
	);
}

function Tab({
	session: s,
	paneKey,
	groupId,
	index,
	active,
}: {
	session: TermSession;
	paneKey: string;
	groupId: string;
	index: number;
	active: boolean;
}) {
	const c = usePane();
	if (c.editingId === s.id) {
		return (
			<input
				className={styles.tabInput}
				value={c.draftName}
				autoFocus
				onChange={(e) => c.setDraftName(e.target.value)}
				onBlur={c.commitRename}
				onKeyDown={(e) => {
					if (e.key === "Enter") c.commitRename();
					else if (e.key === "Escape") c.cancelRename();
				}}
				spellCheck={false}
			/>
		);
	}
	return (
		<button
			className={styles.tab}
			data-active={active || undefined}
			data-dragging={c.dragging === paneKey || undefined}
			draggable
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", paneKey); // some drop targets require data
				c.setDragging(paneKey);
			}}
			onDragEnd={() => c.setDragging(null)}
			onDragOver={(e) => c.dragging && c.dragging !== paneKey && e.preventDefault()}
			onDrop={(e) => {
				if (!c.dragging) return;
				e.preventDefault();
				e.stopPropagation();
				const tab = c.dragging;
				c.setDragging(null);
				moveTab(c.worktreeId, tab, groupId, index); // insert before this tab
			}}
			onClick={() => setActiveSession(s.id)}
			onDoubleClick={() => c.startRename(s)}
			title={`${s.title} — double-click to rename`}
		>
			{s.kind === "chat" ? (
				<SparkleIcon size={12} />
			) : s.kind === "terminal" ? (
				<TerminalIcon size={12} />
			) : (
				<FileIcon size={12} />
			)}
			<span className={styles.tabLabel}>{s.name ?? tabLabel(s)}</span>
			<span
				className={styles.tabClose}
				onClick={(e) => {
					e.stopPropagation();
					endSession(s);
				}}
			>
				<CloseIcon size={12} />
			</span>
		</button>
	);
}

/** Tab label: drop the "branch · " prefix since all tabs share this worktree. */
function tabLabel(s: TermSession): string {
	const i = s.title.indexOf(" · ");
	return i === -1 ? s.title : s.title.slice(i + 3);
}
