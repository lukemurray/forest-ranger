import { useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { CommandRunTarget, ProjectCommand } from "../../shared/types";
import { worktreeRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { CommandDialog } from "../components/CommandDialog";
import { RemoveWorktreeDialog } from "../components/RemoveWorktreeDialog";
import { RunCommands } from "../components/RunCommands";
import { SessionWorkspace } from "../components/SessionWorkspace";
import { ReviewPanel } from "../components/ReviewPanel";
import {
	FolderIcon,
	GitBranchIcon,
	PanelRightIcon,
	RevealIcon,
	TerminalIcon,
	TrashIcon,
} from "../components/icons";
import { api, emitDataChanged } from "../rpc";
import { openInEditor, openInTerminal, runProjectCommand } from "../lib/openTargets";
import { openSession } from "../lib/terminalStore";
import { useDefaultRunTarget } from "../lib/runTarget";
import tb from "../components/Titlebar.module.css";
import styles from "./WorktreeView.module.css";

const REVIEW_WIDTH_KEY = "forest-ranger:review-width";

export function WorktreeView() {
	const detail = worktreeRoute.useLoaderData();
	const { projectId } = worktreeRoute.useParams();
	const navigate = useNavigate();
	const router = useRouter();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(true);
	const [reviewWidth, setReviewWidth] = useState(
		() => Number(localStorage.getItem(REVIEW_WIDTH_KEY)) || 480,
	);
	const drag = useRef<{ start: number; width: number } | null>(null);
	const defaultTarget = useDefaultRunTarget();

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
				title: `${branch ?? "detached"} · ${cmd.label}`,
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
						<RunCommands
							commands={commands}
							onRun={run}
							onEdit={openEdit}
							onDelete={removeCommand}
							onAdd={openAdd}
						/>
						<button className={tb.actionButton} onClick={() => openInEditor(worktree.path)}>
							<FolderIcon /> Editor
						</button>
						<button className={tb.actionButton} onClick={() => openInTerminal(worktree.path)}>
							<TerminalIcon /> Terminal
						</button>
						<button
							className={tb.actionButton}
							onClick={() => api.revealInFinder({ path: worktree.path })}
							title="Reveal in Finder"
						>
							<RevealIcon />
						</button>
						{!worktree.isPrimary && (
							<button
								className={tb.actionButton}
								onClick={() => setRemoveOpen(true)}
								title="Remove worktree"
							>
								<TrashIcon />
							</button>
						)}
						<button
							className={tb.actionButton}
							data-active={reviewOpen || undefined}
							onClick={() => setReviewOpen((v) => !v)}
							title={reviewOpen ? "Hide review panel" : "Show review panel"}
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
				{branch ?? "detached"}
				{upstream && <span className={styles.upstream}>→ {upstream}</span>}
			</Titlebar>

			<div className={styles.split}>
				<div className={styles.center}>
					<SessionWorkspace
						worktreeId={worktree.id}
						projectId={projectId}
						branch={branch}
					/>
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
