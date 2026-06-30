import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { CommandRunTarget, ProjectCommand } from "../../shared/types";
import { projectRoute, rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { Button } from "../components/ui/Button";
import { BranchSyncBar } from "../components/BranchSyncBar";
import { WorktreeCard } from "../components/WorktreeCard";
import { CommandDialog } from "../components/CommandDialog";
import { NewWorktreeDialog } from "../components/NewWorktreeDialog";
import {
	FolderIcon,
	PencilIcon,
	PlusIcon,
	RevealIcon,
	TrashIcon,
} from "../components/icons";
import { api, emitDataChanged } from "../rpc";
import { openSession } from "../lib/terminalStore";
import { getChatConfig } from "../lib/chatConfig";
import tb from "../components/Titlebar.module.css";
import styles from "./Page.module.css";

export function ProjectView() {
	const worktrees = projectRoute.useLoaderData();
	const { projectId } = projectRoute.useParams();
	const projects = rootRoute.useLoaderData();
	const project = projects.find((p) => p.id === projectId);
	const navigate = useNavigate();

	const [commands, setCommands] = useState<ProjectCommand[]>([]);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);
	const [newOpen, setNewOpen] = useState(false);

	function onWorktreeCreated(worktreeId: string, _path: string, startChat: boolean) {
		emitDataChanged("worktrees"); // refresh sidebar + project grid
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId },
		});
		if (startChat) {
			const config = getChatConfig();
			openSession({
				worktreeId,
				projectId,
				kind: "chat",
				commandId: null,
				command: null,
				resumeCommand: null,
				sessionId: crypto.randomUUID(),
				permissionMode: config.defaultPermissionMode,
				model: config.defaultModel,
				agentLabel: "Claude",
				name: "New chat",
				title: "Claude",
			});
		}
	}

	const loadCommands = useCallback(() => {
		api.listCommands({ projectId }).then(setCommands);
	}, [projectId]);

	useEffect(() => {
		loadCommands();
	}, [loadCommands]);

	function openAdd() {
		setEditing(null);
		setDialogOpen(true);
	}
	function openEdit(cmd: ProjectCommand) {
		setEditing(cmd);
		setDialogOpen(true);
	}
	async function submit(
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
		loadCommands();
	}
	async function remove(id: string) {
		await api.removeCommand({ id });
		loadCommands();
	}

	if (!project) {
		return (
			<div className={styles.view}>
				<Titlebar>Project unavailable</Titlebar>
				<div className={styles.scroll}>
					<div className={styles.page}>
						<p className={styles.hint}>This project is no longer available.</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.view}>
			<Titlebar
				title={project.path}
				actions={
					<button
						className={tb.actionButton}
						onClick={() => api.revealInFinder({ path: project.path })}
					>
						<RevealIcon /> Reveal
					</button>
				}
			>
				<FolderIcon size={16} /> {project.name}
				<span className={tb.muted}>
					· {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"}
				</span>
			</Titlebar>

			<div className={styles.scroll}>
				<div className={styles.page}>
					<BranchSyncBar projectId={projectId} />

					<section className={styles.section}>
						<div className={styles.sectionHead}>
							<h2 className={styles.sectionTitle}>Commands</h2>
							<Button variant="ghost" icon={<PlusIcon size={14} />} onClick={openAdd}>
								Add command
							</Button>
						</div>
						{commands.length === 0 ? (
							<p className={styles.hint}>
								No commands yet. Add one (e.g. “Run” → “npm run dev”) to launch it on
								any worktree.
							</p>
						) : (
							<ul className={styles.commandList}>
								{commands.map((cmd) => (
									<li key={cmd.id} className={styles.commandRow}>
										<span className={styles.commandLabel}>{cmd.label}</span>
										<code className={styles.commandText}>
											{cmd.dir && <span className={styles.commandDir}>{cmd.dir}/</span>}
											{cmd.command}
										</code>
										<button
											className={styles.commandAction}
											onClick={() => openEdit(cmd)}
											title="Edit"
										>
											<PencilIcon size={14} />
										</button>
										<button
											className={styles.commandAction}
											data-danger
											onClick={() => remove(cmd.id)}
											title="Delete"
										>
											<TrashIcon size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
					</section>

					<section className={styles.section}>
						<div className={styles.sectionHead}>
							<h2 className={styles.sectionTitle}>Worktrees</h2>
							<Button
								variant="ghost"
								icon={<PlusIcon size={14} />}
								onClick={() => setNewOpen(true)}
							>
								New worktree
							</Button>
						</div>
						{worktrees.length === 0 ? (
							<p className={styles.hint}>No worktrees found for this project.</p>
						) : (
							<div className={styles.grid}>
								{worktrees.map((wt) => (
									<WorktreeCard key={wt.id} worktree={wt} />
								))}
							</div>
						)}
					</section>
				</div>
			</div>

			<CommandDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editing ? "Edit command" : "Add command"}
				initialLabel={editing?.label ?? ""}
				initialCommand={editing?.command ?? ""}
				initialDir={editing?.dir ?? ""}
				initialRunTarget={editing?.runTarget ?? "in-app"}
				onSubmit={submit}
			/>
			<NewWorktreeDialog
				open={newOpen}
				onOpenChange={setNewOpen}
				projectId={projectId}
				onCreated={onWorktreeCreated}
			/>
		</div>
	);
}
