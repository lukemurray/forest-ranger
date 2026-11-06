import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type {
	CommandRunTarget,
	IntegrationType,
	ProjectCommand,
	ProjectIntegrationChoice,
	ProjectIntegrationInfo,
} from "../../shared/types";
import { Select } from "../components/ui/Select";
import { projectRoute, rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { Button } from "../components/ui/Button";
import { BranchSyncBar } from "../components/BranchSyncBar";
import { WorktreeCard } from "../components/WorktreeCard";
import { ProjectBranches } from "../components/ProjectBranches";
import { CommandDialog } from "../components/CommandDialog";
import { NewWorktreeDialog } from "../components/NewWorktreeDialog";
import { ReviewDialog, ReviewPromptField } from "../components/ReviewDialog";
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
import { useProjectActions } from "../lib/useProjectActions";
import tb from "../components/Titlebar.module.css";
import styles from "./Page.module.css";

type Tab = "worktrees" | "branches" | "settings";

export function ProjectView() {
	const worktrees = projectRoute.useLoaderData();
	const { projectId } = projectRoute.useParams();
	const projects = rootRoute.useLoaderData();
	const project = projects.find((p) => p.id === projectId);
	const router = useRouter();

	const [commands, setCommands] = useState<ProjectCommand[]>([]);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);
	const [newOpen, setNewOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [tab, setTab] = useState<Tab>("worktrees");

	const { onWorktreeCreated, startReview } = useProjectActions(projectId);

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

					{tab === "settings" && (
						<section className={styles.section}>
							<div className={styles.sectionHead}>
								<h2 className={styles.sectionTitle}>Code host</h2>
							</div>
							<CodeHostField projectId={projectId} />
						</section>
					)}

					{tab === "settings" && (
						<section className={styles.section}>
							<div className={styles.sectionHead}>
								<h2 className={styles.sectionTitle}>Review prompt</h2>
							</div>
							<ReviewPromptField projectId={projectId} />
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

const PROVIDER_LABEL: Record<IntegrationType, string> = { github: "GitHub", gitlab: "GitLab" };
const CONNECTION_LABEL = { cli: "its CLI", oauth: "browser sign-in", token: "an access token" } as const;

/**
 * Which integration (GitHub / GitLab) this project uses for MR/PR and pipeline
 * status: auto-detected from origin's host, or set here — e.g. for an SSH alias or
 * custom domain the host match can't see through, or "None" to turn it off.
 */
function CodeHostField({ projectId }: { projectId: string }) {
	const [info, setInfo] = useState<ProjectIntegrationInfo | null | undefined>(undefined);
	const load = useCallback(() => {
		api.projectIntegration({ projectId }).then(setInfo);
	}, [projectId]);
	useEffect(load, [load]);

	if (info === undefined) return <p className={styles.hint}>Checking…</p>;
	if (info === null) return null;

	const autoLabel = info.detected ? `Auto (${PROVIDER_LABEL[info.detected]})` : "Auto (no match)";
	const eff = info.effective;
	let status: string;
	if (!eff) {
		status =
			info.override === "none"
				? "Turned off for this project."
				: info.remote
					? "No integration matches this host — pick one above if it should use one."
					: "No origin remote, so there's nothing to look up.";
	} else if (!eff.enabled || !eff.connection) {
		status = `${PROVIDER_LABEL[eff.type]} isn't connected — set it up in Settings → Integrations.`;
	} else {
		const how = eff.connection === "cli" ? (eff.type === "github" ? "gh" : "glab") : CONNECTION_LABEL[eff.connection];
		status = `Using ${PROVIDER_LABEL[eff.type]} via ${how}${eff.user ? ` as @${eff.user}` : ""}.`;
	}

	return (
		<div className={styles.codeHost}>
			<p className={styles.hint}>
				Origin: <code>{info.remote ?? "none"}</code>
			</p>
			<div className={styles.codeHostPick}>
				<Select
					value={info.override}
					onValueChange={async (v) => {
						await api.setProjectIntegration({ projectId, integration: v as ProjectIntegrationChoice });
						load();
						emitDataChanged("worktrees"); // re-fetch MR/PR status with the new choice
					}}
					options={[
						{ value: "auto", label: autoLabel },
						{ value: "github", label: "GitHub" },
						{ value: "gitlab", label: "GitLab" },
						{ value: "none", label: "None" },
					]}
					ariaLabel="Code host integration"
				/>
			</div>
			<p className={styles.hint}>{status}</p>
		</div>
	);
}
