import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectCommand, Worktree } from "../../shared/types";
import { api, emitDataChanged } from "../rpc";
import { relativeTime, shortHash, tildePath } from "../lib/format";
import { openInEditor, openInTerminal, runProjectCommand } from "../lib/openTargets";
import { FolderIcon, GitBranchIcon, PencilIcon, PlayIcon, RevealIcon, TerminalIcon, TrashIcon } from "./icons";
import { MenuItem, OpenItems, RowMenu, Separator } from "./RowMenu";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import styles from "./WorktreeCard.module.css";

export function WorktreeCard({
	worktree,
	projectName,
	commands = [],
}: {
	worktree: Worktree;
	projectName?: string;
	/** Project commands to expose as run-buttons on the card (project view). */
	commands?: ProjectCommand[];
}) {
	const navigate = useNavigate();
	const [removeOpen, setRemoveOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);

	function open() {
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId: worktree.projectId, worktreeId: worktree.id },
		});
	}

	function goToProject(e: React.MouseEvent) {
		e.stopPropagation();
		navigate({
			to: "/project/$projectId",
			params: { projectId: worktree.projectId },
		});
	}

	function reveal(e: React.MouseEvent) {
		e.stopPropagation();
		api.revealInFinder({ path: worktree.path });
	}

	/** Wrap an action so clicking it doesn't also trigger the card's navigate. */
	const act = (fn: () => void) => (e: React.MouseEvent) => {
		e.stopPropagation();
		fn();
	};

	return (
		<>
			<RowMenu
				trigger={
					<div className={styles.card}>
						<button className={styles.body} onClick={open} title="View worktree">
							<CardBody worktree={worktree} projectName={projectName} goToProject={goToProject} reveal={reveal} />
						</button>
						<div className={styles.actions}>
							<button
								className={styles.actionBtn}
								onClick={act(() => openInEditor(worktree.path))}
								title="Open in editor"
							>
								<FolderIcon size={14} /> Editor
							</button>
							<button
								className={styles.actionBtn}
								onClick={act(() => openInTerminal(worktree.path))}
								title="Open in terminal"
							>
								<TerminalIcon size={14} /> Terminal
							</button>
							{commands.map((c) => (
								<button
									key={c.id}
									className={styles.cmdBtn}
									onClick={act(() => runProjectCommand(c.id, worktree.path))}
									title={c.command}
								>
									<PlayIcon size={12} /> {c.label}
								</button>
							))}
						</div>
					</div>
				}
			>
				<OpenItems path={worktree.path} />
				{worktree.branch && !worktree.isDetached && (
					<>
						<Separator />
						<MenuItem
							icon={<PencilIcon size={15} />}
							label="Rename branch…"
							onClick={() => setRenameOpen(true)}
						/>
					</>
				)}
				{!worktree.isPrimary && (
					<>
						<Separator />
						<MenuItem
							icon={<TrashIcon size={15} />}
							label="Remove worktree…"
							danger
							onClick={() => setRemoveOpen(true)}
						/>
					</>
				)}
			</RowMenu>
			{worktree.branch && (
				<RenameBranchDialog
					open={renameOpen}
					onOpenChange={setRenameOpen}
					projectId={worktree.projectId}
					branch={worktree.branch}
					onRenamed={() => emitDataChanged("worktrees")}
				/>
			)}
			<RemoveWorktreeDialog
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				worktreeId={worktree.id}
				onRemoved={() => emitDataChanged("worktrees")}
			/>
		</>
	);
}

function CardBody({
	worktree,
	projectName,
	goToProject,
	reveal,
}: {
	worktree: Worktree;
	projectName?: string;
	goToProject: (e: React.MouseEvent) => void;
	reveal: (e: React.MouseEvent) => void;
}) {
	return (
		<>
			<div className={styles.top}>
				<span className={styles.branch}>
					<GitBranchIcon />
					{worktree.branch ?? "detached"}
				</span>
				<div className={styles.badges}>
					{worktree.isPrimary && <span className={styles.primary}>primary</span>}
					{worktree.isDetached && <span className={styles.detached}>detached</span>}
					{worktree.isLocked && <span className={styles.locked}>locked</span>}
				</div>
			</div>

			<div className={styles.path} title={worktree.path}>
				{projectName && (
					<span className={styles.project} onClick={goToProject} title="Go to project">
						{projectName}
					</span>
				)}
				{tildePath(worktree.path)}
			</div>

			<div className={styles.meta}>
				<span className={styles.hash}>{shortHash(worktree.head)}</span>
				<span className={styles.dot}>·</span>
				<span>{relativeTime(worktree.lastActivityAt)}</span>
				<span className={styles.spacer} />
				<span className={styles.reveal} onClick={reveal} title="Reveal in Finder">
					<RevealIcon />
				</span>
			</div>
		</>
	);
}
