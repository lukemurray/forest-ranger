import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import type { Project, Worktree } from "../../shared/types";
import { api, emitDataChanged, onDataChanged } from "../rpc";
import { relativeTime } from "../lib/format";
import {
	ActivityIcon,
	ChevronIcon,
	ClockIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	RevealIcon,
	TreeIcon,
	TrashIcon,
} from "./icons";
import { MenuItem, OpenItems, RowMenu, Separator } from "./RowMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameWorktreeDialog } from "./RenameWorktreeDialog";
import { SettingsMenu } from "./SettingsMenu";
import { getRestorableSessions, useTerminals } from "../lib/terminalStore";
import styles from "./Sidebar.module.css";

export function Sidebar({ projects }: { projects: Project[] }) {
	const router = useRouter();
	const navigate = useNavigate();
	const [adding, setAdding] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const { sessions } = useTerminals();
	const runningCount = sessions.filter((s) => s.running).length;
	const runningWorktrees = new Set(
		sessions.filter((s) => s.running).map((s) => s.worktreeId),
	);
	const runningProjects = new Set(
		sessions.filter((s) => s.running).map((s) => s.projectId),
	);
	// Chats saved from a previous run that haven't been reopened yet (e.g. right
	// after launch). Marked with a hollow dot so you can see where work is waiting
	// to resume; once a worktree is opened its chats relaunch and become "running".
	const resumableChats = getRestorableSessions().filter(
		(s) => s.kind === "chat" && s.sessionId && !runningWorktrees.has(s.worktreeId),
	);
	const resumableWorktrees = new Set(resumableChats.map((s) => s.worktreeId));
	const resumableProjects = new Set(
		resumableChats.map((s) => s.projectId).filter((id) => !runningProjects.has(id)),
	);

	async function addProject() {
		setAdding(true);
		setNotice(null);
		try {
			const result = await api.addProject({});
			switch (result.status) {
				case "added":
				case "exists":
					await router.invalidate();
					navigate({
						to: "/project/$projectId",
						params: { projectId: result.project.id },
					});
					break;
				case "not-a-repo":
					setNotice("That folder isn't a git repository.");
					break;
				case "git-missing":
					setNotice("Couldn't run git. Is it installed and on your PATH?");
					break;
				case "cancelled":
					break;
			}
		} catch (err) {
			setNotice(`Failed to add project: ${String(err)}`);
		} finally {
			setAdding(false);
		}
	}

	return (
		<aside className={styles.sidebar}>
			<div className={`${styles.dragSpacer} app-region-drag`} />
			<div className={`${styles.header} app-region-drag`}>
				<span className={styles.brand}>
					<TreeIcon /> Forest Ranger
				</span>
				<button
					className={`${styles.iconButton} app-region-no-drag`}
					onClick={addProject}
					disabled={adding}
					title="Add a git project"
				>
					<PlusIcon />
				</button>
			</div>

			<Link
				to="/"
				className={styles.recentLink}
				activeOptions={{ exact: true }}
				activeProps={{ className: styles.recentLinkActive }}
			>
				<ClockIcon /> Recent worktrees
			</Link>

			<Link
				to="/activity"
				className={styles.recentLink}
				activeProps={{ className: styles.recentLinkActive }}
			>
				<ActivityIcon /> Activity
				{runningCount > 0 && <span className={styles.navBadge}>{runningCount}</span>}
			</Link>

			{notice && <div className={styles.notice}>{notice}</div>}

			<div className={styles.sectionLabel}>Projects</div>

			<nav className={styles.projects}>
				{projects.length === 0 ? (
					<p className={styles.empty}>No projects yet. Add a git repo to begin.</p>
				) : (
					projects.map((p) => (
						<ProjectNode
							key={p.id}
							project={p}
							runningProjects={runningProjects}
							runningWorktrees={runningWorktrees}
							resumableProjects={resumableProjects}
							resumableWorktrees={resumableWorktrees}
						/>
					))
				)}
			</nav>

			<SettingsMenu />
		</aside>
	);
}

function ProjectNode({
	project,
	runningProjects,
	runningWorktrees,
	resumableProjects,
	resumableWorktrees,
}: {
	project: Project;
	runningProjects: Set<string>;
	runningWorktrees: Set<string>;
	resumableProjects: Set<string>;
	resumableWorktrees: Set<string>;
}) {
	const navigate = useNavigate();
	const router = useRouter();
	const params = useParams({ strict: false });
	const onThisProject = params.projectId === project.id;
	// Only the project row itself is "selected" on the project route; when a
	// worktree under it is open, the highlighted child carries the selection.
	const projectActive = onThisProject && !params.worktreeId;

	const [open, setOpen] = useState(onThisProject);
	const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [renaming, setRenaming] = useState<Worktree | null>(null);
	const fetching = useRef(false);

	async function removeProject() {
		await api.removeProject({ id: project.id });
		await router.invalidate();
		if (onThisProject) navigate({ to: "/" });
	}

	// Fetch once (cached); pass force to bypass the cache after a change.
	const loadWorktrees = useCallback(
		(force = false) => {
			if ((!force && worktrees !== null) || fetching.current) return;
			fetching.current = true;
			api
				.listWorktrees({ projectId: project.id })
				.then(setWorktrees)
				.finally(() => {
					fetching.current = false;
				});
		},
		[worktrees, project.id],
	);

	useEffect(() => {
		if (open) loadWorktrees();
	}, [open, loadWorktrees]);

	// Refetch when worktrees change (e.g. a new one was created) if expanded.
	useEffect(() => {
		const off = onDataChanged((scope) => {
			if (scope === "worktrees" && open) loadWorktrees(true);
		});
		return () => {
			off();
		};
	}, [open, loadWorktrees]);

	// Expand the project when you navigate into it or any of its worktrees —
	// including from the project's own worktree grid (where the project is
	// already active, so we also key off the selected worktree changing).
	useEffect(() => {
		if (onThisProject) setOpen(true);
	}, [onThisProject, params.worktreeId]);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} className={styles.node}>
			<RowMenu
				trigger={
					<div
						className={styles.projectRow}
						data-active={projectActive || undefined}
						data-within={(onThisProject && !projectActive) || undefined}
						onMouseEnter={() => loadWorktrees()}
					>
						<Collapsible.Trigger className={styles.chevron} aria-label="Toggle worktrees">
							<ChevronIcon />
						</Collapsible.Trigger>
						<button
							className={styles.projectName}
							onClick={() =>
								navigate({ to: "/project/$projectId", params: { projectId: project.id } })
							}
							title={project.path}
						>
							{project.name}
						</button>
						<button
							className={styles.projectRefresh}
							onClick={(e) => {
								e.stopPropagation();
								emitDataChanged("worktrees"); // reloads sidebar list, branches, sync bar
								router.invalidate(); // reloads the project view's worktree grid
							}}
							title="Rescan worktrees"
						>
							<RefreshIcon size={13} />
						</button>
						{runningProjects.has(project.id) ? (
							<span className={styles.runningDot} title="task running" />
						) : (
							resumableProjects.has(project.id) && (
								<span className={styles.resumeDot} title="a chat here can resume" />
							)
						)}
					</div>
				}
			>
				<MenuItem
					icon={<RevealIcon size={15} />}
					label="Reveal in Finder"
					onClick={() => api.revealInFinder({ path: project.path })}
				/>
				<Separator />
				<MenuItem
					icon={<TrashIcon size={15} />}
					label="Remove project"
					danger
					onClick={() => setConfirmOpen(true)}
				/>
			</RowMenu>

			<Collapsible.Panel className={styles.panel}>
				{worktrees === null ? (
					<div className={styles.loading}>Loading…</div>
				) : worktrees.length === 0 ? (
					<div className={styles.loading}>No worktrees</div>
				) : (
					worktrees.map((wt) => (
						<RowMenu
							key={wt.id}
							trigger={
								<button
									className={styles.worktree}
									data-active={params.worktreeId === wt.id || undefined}
									onClick={() =>
										navigate({
											to: "/project/$projectId/worktree/$worktreeId",
											params: { projectId: project.id, worktreeId: wt.id },
										})
									}
									title={wt.path}
								>
									<span className={styles.worktreeBranch}>
										{wt.name ?? wt.branch ?? "detached"}
										{wt.isPrimary && <span className={styles.primaryDot} title="primary worktree" />}
									</span>
									{runningWorktrees.has(wt.id) ? (
										<span className={styles.runningDot} title="task running" />
									) : (
										<>
											{resumableWorktrees.has(wt.id) && (
												<span className={styles.resumeDot} title="a chat here can resume" />
											)}
											<span className={styles.worktreeTime}>
												{relativeTime(wt.lastActivityAt)}
											</span>
										</>
									)}
								</button>
							}
						>
							<OpenItems path={wt.path} />
							<Separator />
							<MenuItem
								icon={<PencilIcon size={15} />}
								label="Rename…"
								onClick={() => setRenaming(wt)}
							/>
						</RowMenu>
					))
				)}
			</Collapsible.Panel>

			{renaming && (
				<RenameWorktreeDialog
					open={!!renaming}
					onOpenChange={(o) => !o && setRenaming(null)}
					worktreeId={renaming.id}
					current={renaming.name ?? renaming.branch ?? ""}
					onRenamed={() => {
						setRenaming(null);
						loadWorktrees(true);
						emitDataChanged("worktrees");
					}}
				/>
			)}

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Remove project?"
				description={`"${project.name}" will be removed from Forest Ranger. Your git repository and its worktrees on disk are not touched.`}
				confirmLabel="Remove"
				danger
				onConfirm={removeProject}
			/>
		</Collapsible.Root>
	);
}
