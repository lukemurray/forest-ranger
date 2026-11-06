import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ChatLogMeta, CommandRunTarget, ProjectCommand } from "../../shared/types";
import { worktreeRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { CommandDialog } from "../components/CommandDialog";
import { RemoveWorktreeDialog } from "../components/RemoveWorktreeDialog";
import { RunCommands } from "../components/RunCommands";
import { Dropdown, DropdownItem } from "../components/Dropdown";
import { SessionWorkspace } from "../components/SessionWorkspace";
import { ReviewPanel } from "../components/ReviewPanel";
import {
	ChevronDownIcon,
	EllipsisIcon,
	FolderIcon,
	GitBranchIcon,
	PanelRightIcon,
	PlusIcon,
	RevealIcon,
	SparkleIcon,
	TerminalIcon,
	TrashIcon,
} from "../components/icons";
import { api, emitDataChanged } from "../rpc";
import { providerLabel, useChatConfig } from "../lib/chatConfig";
import { relativeTime } from "../lib/format";
import { worktreeLabel } from "../lib/worktreeLabel";
import { openInEditor, runProjectCommand } from "../lib/openTargets";
import { openSession, useTerminals } from "../lib/terminalStore";
import { setPanelWorktree, togglePanel, usePanel } from "../lib/panelStore";
import { useDefaultRunTarget } from "../lib/runTarget";
import tb from "../components/Titlebar.module.css";
import styles from "./WorktreeView.module.css";

const REVIEW_WIDTH_KEY = "forest-ranger:review-width";

export function WorktreeView() {
	const detail = worktreeRoute.useLoaderData();
	const { projectId } = worktreeRoute.useParams();
	const navigate = useNavigate();
	const router = useRouter();
	const { sessions } = useTerminals();
	const config = useChatConfig();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [pastChats, setPastChats] = useState<ChatLogMeta[]>([]);
	// Panel open/view live in a small store so global shortcuts (⌘B/⌘1/⌘2) can drive
	// them; still persisted across navigation and restarts.
	const { open: reviewOpen } = usePanel();
	const [reviewWidth, setReviewWidth] = useState(
		() => Number(localStorage.getItem(REVIEW_WIDTH_KEY)) || 480,
	);
	const drag = useRef<{ start: number; width: number } | null>(null);
	const defaultTarget = useDefaultRunTarget();

	const wtId = detail?.worktree.id ?? null;
	// Before paint, so the panel doesn't flash the previous worktree's state.
	useLayoutEffect(() => setPanelWorktree(wtId), [wtId]);
	const wtSessions = sessions.filter((s) => s.worktreeId === wtId);
	// Past chats for this worktree not currently open — offered under Chat's ▾.
	useEffect(() => {
		if (wtId) api.listChats({ worktreeId: wtId }).then(setPastChats);
	}, [wtId, wtSessions.length]);

	function openAdd() {
		setEditing(null);
		setDialogOpen(true);
	}
	function openEdit(cmd: ProjectCommand) {
		setEditing(cmd);
		setDialogOpen(true);
	}
	async function submitCommand(
		label: string,
		command: string,
		dir: string,
		runTarget: CommandRunTarget,
	) {
		if (editing) {
			await api.updateCommand({ id: editing.id, label, command, dir, runTarget });
		} else {
			await api.addCommand({ projectId, label, command, dir, runTarget });
		}
		router.invalidate();
	}
	async function removeCommand(id: string) {
		await api.removeCommand({ id });
		router.invalidate();
	}

	if (!detail) {
		return (
			<div className={styles.view}>
				<Titlebar>Worktree unavailable</Titlebar>
				<div className={styles.split}>
					<p className={styles.gone}>This worktree no longer exists.</p>
				</div>
			</div>
		);
	}

	const { worktree, projectName, branch, upstream, commands } = detail;
	// Detached: name it by the branch it came from (the title shows branches, not labels).
	const label = branch ?? worktreeLabel({ ...worktree, name: null }).label;
	const openIds = new Set(wtSessions.map((s) => s.sessionId).filter(Boolean));
	const reopenable = pastChats.filter((c) => !openIds.has(c.sessionId));

	function startChat() {
		const agent = providerLabel(config.defaultProvider);
		openSession({
			worktreeId: worktree.id,
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
			worktreeId: worktree.id,
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
	// Reopen a persisted chat by its session id, resuming the agent's context.
	function reopenChat(c: ChatLogMeta) {
		const agent = providerLabel(c.provider);
		openSession({
			worktreeId: worktree.id,
			projectId,
			kind: "chat",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: c.sessionId,
			resume: true,
			provider: c.provider,
			permissionMode: config.defaultPermissionMode,
			model: c.model,
			agentLabel: agent,
			name: c.name,
			renamed: true,
			title: `${label} · ${agent}`,
		});
	}

	function run(cmd: ProjectCommand) {
		const target = cmd.runTarget === "default" ? defaultTarget : cmd.runTarget;
		if (target === "external") {
			runProjectCommand(cmd.id, worktree.path);
		} else {
			openSession({
				worktreeId: worktree.id,
				projectId,
				kind: "terminal",
				commandId: cmd.id,
				command: null,
				resumeCommand: null,
				sessionId: null,
				name: cmd.label,
				title: `${label} · ${cmd.label}`,
			});
		}
	}

	function selectBase(next: string) {
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId: worktree.id },
			search: { base: next || undefined },
		});
	}

	function onResizeDown(e: React.MouseEvent) {
		drag.current = { start: e.clientX, width: reviewWidth };
		const move = (ev: MouseEvent) => {
			if (!drag.current) return;
			const delta = drag.current.start - ev.clientX; // drag left = wider
			const next = Math.max(320, Math.min(900, drag.current.width + delta));
			setReviewWidth(next);
			localStorage.setItem(REVIEW_WIDTH_KEY, String(next));
		};
		const up = () => {
			drag.current = null;
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	return (
		<div className={styles.view}>
			<Titlebar
				title={worktree.path}
				actions={
					<>
						{reopenable.length > 0 ? (
							// Split: the face starts a new chat; the arrow reopens a past one.
							<div className={tb.split}>
								<button className={tb.splitMain} onClick={startChat} data-tip="New chat" aria-label="New chat">
									<SparkleIcon size={13} /> Chat
								</button>
								<Dropdown
									trigger={
										<button
											className={tb.splitArrow}
											data-tip="Reopen a past chat"
											aria-label="Reopen a past chat in this worktree"
										>
											<ChevronDownIcon size={12} />
										</button>
									}
								>
									{reopenable.map((c) => (
										<DropdownItem
											key={c.sessionId}
											label={c.name}
											hint={relativeTime(c.updatedAt)}
											onClick={() => reopenChat(c)}
										/>
									))}
								</Dropdown>
							</div>
						) : (
							<button className={tb.actionButton} onClick={startChat} data-tip="New chat" aria-label="New chat">
								<SparkleIcon size={14} /> Chat
							</button>
						)}
						<button
							className={tb.iconBtn}
							onClick={startTerminal}
							data-tip="New terminal"
							aria-label="New terminal"
						>
							<TerminalIcon />
						</button>
						<button
							className={tb.iconBtn}
							onClick={() => openInEditor(worktree.path)}
							data-tip="Open in editor"
							aria-label="Open in editor"
						>
							<FolderIcon />
						</button>

						<span className={tb.sep} />

						<RunCommands commands={commands} onRun={run} onEdit={openEdit} onDelete={removeCommand} />

						<Dropdown
							trigger={
								<button className={tb.iconBtn} data-tip="More" aria-label="More actions">
									<EllipsisIcon size={16} />
								</button>
							}
						>
							<DropdownItem
								icon={<PlusIcon size={15} />}
								label="Add run command…"
								onClick={openAdd}
							/>
							<DropdownItem
								icon={<RevealIcon size={15} />}
								label="Reveal in Finder"
								onClick={() => api.revealInFinder({ path: worktree.path })}
							/>
							{!worktree.isPrimary && (
								<DropdownItem
									icon={<TrashIcon size={15} />}
									label="Remove worktree…"
									danger
									onClick={() => setRemoveOpen(true)}
								/>
							)}
						</Dropdown>

						<button
							className={tb.iconBtn}
							data-active={reviewOpen || undefined}
							data-tip={reviewOpen ? "Hide review panel (⌘B)" : "Show review panel (⌘B)"}
							data-tip-align="end"
							aria-label={reviewOpen ? "Hide review panel" : "Show review panel"}
							onClick={togglePanel}
						>
							<PanelRightIcon />
						</button>
					</>
				}
			>
				<button
					className={styles.crumb}
					onClick={() => navigate({ to: "/project/$projectId", params: { projectId } })}
				>
					{projectName}
				</button>
				<span className={tb.muted}>/</span>
				<GitBranchIcon size={15} />
				{label}
				{!branch && <span className={styles.upstream}>(detached)</span>}
				{upstream && <span className={styles.upstream}>→ {upstream}</span>}
			</Titlebar>

			<div className={styles.split}>
				<div className={styles.center}>
					<SessionWorkspace worktreeId={worktree.id} />
				</div>
				{reviewOpen && (
					<>
						<div className={styles.resizer} onMouseDown={onResizeDown} />
						<div className={styles.review} style={{ width: reviewWidth }}>
							<ReviewPanel detail={detail} projectId={projectId} onSelectBase={selectBase} />
						</div>
					</>
				)}
			</div>

			<CommandDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editing ? "Edit command" : "Add command"}
				initialLabel={editing?.label ?? ""}
				initialCommand={editing?.command ?? ""}
				initialDir={editing?.dir ?? ""}
				initialRunTarget={editing?.runTarget ?? "in-app"}
				onSubmit={submitCommand}
			/>
			<RemoveWorktreeDialog
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				worktreeId={worktree.id}
				onRemoved={() => {
					emitDataChanged("worktrees");
					navigate({ to: "/project/$projectId", params: { projectId } });
				}}
			/>
		</div>
	);
}

/**
 * Shown while a worktree's details load (only if that takes over ~150ms — see the
 * route), so a click on a worktree gives feedback at once instead of nothing.
 */
export function WorktreePending() {
	return (
		<div className={styles.view}>
			<Titlebar>
				<span className={tb.muted}>Opening worktree…</span>
			</Titlebar>
			<div className={styles.pendingBar} />
		</div>
	);
}
