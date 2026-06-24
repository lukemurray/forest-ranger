import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import type { Project, Worktree } from "../../shared/types";
import { api } from "../rpc";
import { relativeTime } from "../lib/format";
import {
	ChevronIcon,
	ClockIcon,
	PlusIcon,
	RevealIcon,
	TreeIcon,
	TrashIcon,
} from "./icons";
import { MenuItem, OpenItems, RowMenu, Separator } from "./RowMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsMenu } from "./SettingsMenu";
import styles from "./Sidebar.module.css";

export function Sidebar({ projects }: { projects: Project[] }) {
	const router = useRouter();
	const navigate = useNavigate();
	const [adding, setAdding] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

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
			<div className={`${styles.dragSpacer} electrobun-webkit-app-region-drag`} />
			<div className={`${styles.header} electrobun-webkit-app-region-drag`}>
				<span className={styles.brand}>
					<TreeIcon /> Forest Ranger
				</span>
				<button
					className={`${styles.iconButton} electrobun-webkit-app-region-no-drag`}
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

			{notice && <div className={styles.notice}>{notice}</div>}

			<div className={styles.sectionLabel}>Projects</div>

			<nav className={styles.projects}>
				{projects.length === 0 ? (
					<p className={styles.empty}>No projects yet. Add a git repo to begin.</p>
				) : (
					projects.map((p) => <ProjectNode key={p.id} project={p} />)
				)}
			</nav>

			<SettingsMenu />
		</aside>
	);
}

function ProjectNode({ project }: { project: Project }) {
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
	const fetching = useRef(false);

	async function removeProject() {
		await api.removeProject({ id: project.id });
		await router.invalidate();
		if (onThisProject) navigate({ to: "/" });
	}

	// Fetch once; reused by both expand and hover-prefetch so a click feels instant.
	const loadWorktrees = useCallback(() => {
		if (worktrees !== null || fetching.current) return;
		fetching.current = true;
		api
			.listWorktrees({ projectId: project.id })
			.then(setWorktrees)
			.finally(() => {
				fetching.current = false;
			});
	}, [worktrees, project.id]);

	useEffect(() => {
		if (open) loadWorktrees();
	}, [open, loadWorktrees]);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} className={styles.node}>
			<RowMenu
				trigger={
					<div
						className={styles.projectRow}
						data-active={projectActive || undefined}
						data-within={(onThisProject && !projectActive) || undefined}
						onMouseEnter={loadWorktrees}
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
										{wt.branch ?? "detached"}
										{wt.isPrimary && <span className={styles.primaryDot} title="primary worktree" />}
									</span>
									<span className={styles.worktreeTime}>
										{relativeTime(wt.lastActivityAt)}
									</span>
								</button>
							}
						>
							<OpenItems path={wt.path} />
						</RowMenu>
					))
				)}
			</Collapsible.Panel>

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
