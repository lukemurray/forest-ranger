import { useCallback, useEffect, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { CommandRunTarget, ProjectCommand } from "../../shared/types";
import { projectRoute, rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { Button } from "../components/ui/Button";
import { BranchSyncBar } from "../components/BranchSyncBar";
import { WorktreeCard } from "../components/WorktreeCard";
import { ProjectBranches } from "../components/ProjectBranches";
import { CommandDialog } from "../components/CommandDialog";
import { NewWorktreeDialog } from "../components/NewWorktreeDialog";
import { ReviewDialog } from "../components/ReviewDialog";
import {
	FolderIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	RevealIcon,
	SparkleIcon,
	TrashIcon,
} from "../components/icons";
import { api, emitDataChanged } from "../rpc";
import { openSession } from "../lib/terminalStore";
import { getChatConfig, providerLabel } from "../lib/chatConfig";
import { notify } from "../lib/toast";
import tb from "../components/Titlebar.module.css";
import styles from "./Page.module.css";

type Tab = "worktrees" | "branches" | "settings";

export function ProjectView() {
	const worktrees = projectRoute.useLoaderData();
	const { projectId } = projectRoute.useParams();
	const projects = rootRoute.useLoaderData();
	const project = projects.find((p) => p.id === projectId);
	const navigate = useNavigate();
	const router = useRouter();

	const [commands, setCommands] = useState<ProjectCommand[]>([]);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);
	const [newOpen, setNewOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [tab, setTab] = useState<Tab>("worktrees");

	function onWorktreeCreated(worktreeId: string, _path: string, startChat: boolean) {
		emitDataChanged("worktrees"); // refresh sidebar + project grid
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId },
		});
		if (startChat) {
			const config = getChatConfig();
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
				title: agent,
			});
		}
	}

	// Review a branch: detached worktree at its tip + a chat seeded to review it.
	async function startReview(branch: string, _base: string | null, prompt: string) {
		const res = await api.createWorktree({
			projectId,
			name: "",
			base: branch,
			location: null,
			detach: true,
		});
		if (!res.ok || !res.worktreeId) {
			notify(res.error ?? "Failed to create review worktree", "error");
			return;
		}
		emitDataChanged("worktrees");
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId: res.worktreeId },
		});
		const config = getChatConfig();
		const agent = providerLabel(config.defaultProvider);
		openSession({
			worktreeId: res.worktreeId,
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
			name: `Review ${branch}`,
			renamed: true,
			title: `Review ${branch}`,
			initialPrompt: prompt,
		});
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
					<>
						<button
							className={tb.actionButton}
							onClick={() => {
								emitDataChanged("worktrees"); // branches + sync bar
								router.invalidate(); // worktree grid loader
							}}
							title="Rescan worktrees"
						>
							<RefreshIcon /> Refresh
						</button>
						<button
							className={tb.actionButton}
							onClick={() => api.revealInFinder({ path: project.path })}
						>
							<RevealIcon /> Reveal
						</button>
					</>
				}
			>
				<FolderIcon size={16} /> {project.name}
				<span className={tb.muted}>
					· {worktrees.length} worktree{worktrees.length === 1 ? "" : "s"}
				</span>
			</Titlebar>

			<div className={styles.tabs}>
				<button
					className={styles.tab}
					data-active={tab === "worktrees" || undefined}
					onClick={() => setTab("worktrees")}
				>
					Worktrees
				</button>
				<button
					className={styles.tab}
					data-active={tab === "branches" || undefined}
					onClick={() => setTab("branches")}
				>
					Branches
				</button>
				<button
					className={styles.tab}
					data-active={tab === "settings" || undefined}
					onClick={() => setTab("settings")}
				>
					Settings
				</button>
			</div>

			<div className={styles.scroll}>
				<div className={styles.page}>
					{tab === "worktrees" && (
						<>
							<BranchSyncBar projectId={projectId} />

							<section className={styles.section}>
								<div className={styles.sectionHead}>
									<h2 className={styles.sectionTitle}>Worktrees</h2>
									<div className={tb.actions}>
										<Button
											variant="ghost"
											icon={<SparkleIcon size={14} />}
											onClick={() => setReviewOpen(true)}
										>
											Review
										</Button>
										<Button
											variant="ghost"
											icon={<PlusIcon size={14} />}
											onClick={() => setNewOpen(true)}
										>
											New worktree
										</Button>
									</div>
								</div>
								{worktrees.length === 0 ? (
									<p className={styles.hint}>No worktrees found for this project.</p>
								) : (
									<div className={styles.grid}>
										{worktrees.map((wt) => (
											<WorktreeCard key={wt.id} worktree={wt} commands={commands} />
										))}
									</div>
								)}
							</section>
						</>
					)}

					{tab === "branches" && (
						<ProjectBranches projectId={projectId} onCreated={onWorktreeCreated} />
					)}

					{tab === "settings" && (
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
					)}
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
			<ReviewDialog
				open={reviewOpen}
				onOpenChange={setReviewOpen}
				projectId={projectId}
				onSubmit={startReview}
			/>
		</div>
	);
}
