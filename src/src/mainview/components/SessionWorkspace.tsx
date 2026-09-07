import { useEffect, useState } from "react";
import {
	closeSession,
	getRestorableSessions,
	openSession,
	reopenSessions,
	setActiveSession,
	updateSession,
	useTerminals,
	type TermSession,
} from "../lib/terminalStore";
import { providerLabel, useChatConfig } from "../lib/chatConfig";
import { bus } from "../rpc";
import { TerminalPane } from "./TerminalPane";
import { ChatPane } from "./ChatPane";
import { CloseIcon, SparkleIcon, TerminalIcon } from "./icons";
import styles from "./SessionWorkspace.module.css";

/** Stop a session's process (explicit close) and drop the tab. */
function endSession(s: TermSession) {
	if (s.kind === "chat") bus.agentChatStop({ sessionId: s.sessionId ?? s.id });
	else bus.termKill({ sessionId: s.id });
	closeSession(s.id);
}

/**
 * The center workspace for a worktree: a tab strip of all its sessions (chats +
 * terminals) with the active one filling the area. New sessions launch here, so
 * chat and terminal share one home scoped to the worktree.
 */
export function SessionWorkspace({
	worktreeId,
	projectId,
	branch,
}: {
	worktreeId: string;
	projectId: string;
	branch: string | null;
}) {
	const { sessions, activeId } = useTerminals();
	const config = useChatConfig();
	const label = branch ?? "detached";
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");

	const visible = sessions.filter((s) => s.worktreeId === worktreeId);
	const activeVisibleId = visible.some((s) => s.id === activeId)
		? activeId
		: (visible[0]?.id ?? null);

	useEffect(() => {
		if (visible.length > 0 && !visible.some((s) => s.id === activeId)) {
			setActiveSession(visible[0].id);
		}
	}, [visible, activeId]);

	// Reopen every chat that was open for this worktree last time (i.e. not
	// explicitly closed). `getRestorableSessions` skips ones already reopened, so
	// this runs once per worktree per app run.
	useEffect(() => {
		const toReopen = getRestorableSessions(worktreeId).filter(
			(r) => r.kind === "chat" && r.sessionId,
		);
		if (toReopen.length) reopenSessions(toReopen);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [worktreeId]);

	function startChat() {
		const agent = providerLabel(config.defaultProvider);
		openSession({
			worktreeId,
			projectId,
			kind: "chat",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: crypto.randomUUID(),
			provider: config.defaultProvider,
			permissionMode: config.defaultPermissionMode,
			model: config.defaultModel,
			agentLabel: agent,
			name: "New chat",
			title: `${label} · ${agent}`,
		});
	}

	function startTerminal() {
		openSession({
			worktreeId,
			projectId,
			kind: "terminal",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: null,
			name: "Terminal",
			title: `${label} · Terminal`,
		});
	}

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

	const newButtons = (
		<>
			<button className={styles.add} onClick={startChat} title="New chat">
				<SparkleIcon size={13} /> Chat
			</button>
			<button className={styles.add} onClick={startTerminal} title="New terminal">
				<TerminalIcon size={13} /> Terminal
			</button>
		</>
	);

	return (
		<div className={styles.workspace}>
			<div className={styles.tabs}>
				{visible.map((s) =>
					editingId === s.id ? (
						<input
							key={s.id}
							className={styles.tabInput}
							value={draftName}
							autoFocus
							onChange={(e) => setDraftName(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								else if (e.key === "Escape") setEditingId(null);
							}}
							spellCheck={false}
						/>
					) : (
						<button
							key={s.id}
							className={styles.tab}
							data-active={s.id === activeVisibleId || undefined}
							onClick={() => setActiveSession(s.id)}
							onDoubleClick={() => startRename(s)}
							title={`${s.title} — double-click to rename`}
						>
							{s.kind === "chat" ? <SparkleIcon size={12} /> : <TerminalIcon size={12} />}
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
					),
				)}
				<div className={styles.newButtons}>{newButtons}</div>
			</div>

			<div className={styles.body}>
				{visible.length === 0 ? (
					<div className={styles.empty}>
						<p>No sessions in this worktree yet.</p>
						<div className={styles.emptyActions}>{newButtons}</div>
					</div>
				) : (
					visible.map((s) => (
						<div
							key={s.id}
							className={styles.pane}
							style={{ display: s.id === activeVisibleId ? "block" : "none" }}
						>
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
								/>
							) : (
								<TerminalPane
									sessionId={s.id}
									worktreeId={s.worktreeId}
									commandId={s.commandId}
									command={s.command}
								/>
							)}
						</div>
					))
				)}
			</div>
		</div>
	);
}

/** Tab label: drop the "branch · " prefix since all tabs share this worktree. */
function tabLabel(s: TermSession): string {
	const i = s.title.indexOf(" · ");
	return i === -1 ? s.title : s.title.slice(i + 3);
}
