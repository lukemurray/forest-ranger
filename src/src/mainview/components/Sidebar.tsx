import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import type { Project, Worktree } from "../../shared/types";
import { api, emitDataChanged, onDataChanged } from "../rpc";
import { relativeTime } from "../lib/format";
import {
	ChevronIcon,
	HomeIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	RevealIcon,
	SparkleIcon,
	SproutIcon,
	TreeIcon,
	TrashIcon,
} from "./icons";
import { MenuItem, OpenItems, RowMenu, Separator } from "./RowMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameWorktreeDialog } from "./RenameWorktreeDialog";
import { NewWorktreeDialog } from "./NewWorktreeDialog";
import { ReviewDialog } from "./ReviewDialog";
import { SettingsMenu } from "./SettingsMenu";
import { getRestorableSessions, useTerminals } from "../lib/terminalStore";
import { useChatStatus } from "../lib/attentionStore";
import { useProjectActions } from "../lib/useProjectActions";
import { worktreeLabel } from "../lib/worktreeLabel";
import styles from "./Sidebar.module.css";

export function Sidebar({ projects }: { projects: Project[] }) {
	const router = useRouter();
	const navigate = useNavigate();
	const [adding, setAdding] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const { sessions } = useTerminals();
	// Home's badge: chats waiting on you or finished since you last looked.
	const chatStatus = useChatStatus();
	const needsYou = new Set([...chatStatus.attention.sessions, ...chatStatus.unread.sessions]).size;
	// "A chat exists here, at rest" — a single calm hollow dot covering both an open
	// (but idle) chat and one that's only saved-and-resumable. The distinction (live
	// in memory vs persisted) isn't something you act on, so it doesn't earn a
	// separate colour; the working / unread / needs-answer dots are what stand out.
	const openChats = sessions.filter((s) => s.kind === "chat");
	const restorableChats = getRestorableSessions().filter((s) => s.kind === "chat" && s.sessionId);
	const chatWorktrees = new Set([
		...openChats.map((s) => s.worktreeId),
		...restorableChats.map((s) => s.worktreeId),
	]);
	const chatProjects = new Set([
		...openChats.map((s) => s.projectId),
		...restorableChats.map((s) => s.projectId),
	]);

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
				<HomeIcon /> Home
				{needsYou > 0 && <span className={styles.navBadge}>{needsYou}</span>}
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
							chatProjects={chatProjects}
							chatWorktrees={chatWorktrees}
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
	chatProjects,
	chatWorktrees,
}: {
	project: Project;
	chatProjects: Set<string>;
	chatWorktrees: Set<string>;
}) {
	const navigate = useNavigate();
	const router = useRouter();
	const params = useParams({ strict: false });
	const status = useChatStatus();
	const onThisProject = params.projectId === project.id;
	// Only the project row itself is "selected" on the project route; when a
	// worktree under it is open, the highlighted child carries the selection.
	const projectActive = onThisProject && !params.worktreeId;

	const [open, setOpen] = useState(onThisProject);
	const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [renaming, setRenaming] = useState<Worktree | null>(null);
	// Inline label edit (double-click a worktree row).
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	// Escape removes the input, which can fire its blur (= save); this skips that save.
	const labelCancelled = useRef(false);

	/** Save the inline label. Blank, or the branch name itself, clears the label. */
	async function commitLabel(wt: Worktree) {
		setEditingId(null);
		if (labelCancelled.current) return;
		const trimmed = draft.trim();
		const name = !trimmed || trimmed === wt.branch ? null : trimmed;
		if (name === (wt.name ?? null)) return;
		await api.renameWorktree({ id: wt.id, name });
		loadWorktrees(true);
		emitDataChanged("worktrees");
	}
	const [newOpen, setNewOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const fetching = useRef(false);
	const { onWorktreeCreated, startReview } = useProjectActions(project.id);

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
							className={styles.projectAction}
							onClick={(e) => {
								e.stopPropagation();
								setReviewOpen(true);
							}}
							data-tip="Review a branch"
							data-tip-align="end"
							aria-label="Review a branch"
						>
							<SparkleIcon size={13} />
						</button>
						<button
							className={styles.projectAction}
							onClick={(e) => {
								e.stopPropagation();
								setNewOpen(true);
							}}
							data-tip="New worktree"
							data-tip-align="end"
							aria-label="New worktree"
						>
							<PlusIcon size={14} />
						</button>
						<button
							className={styles.projectAction}
							onClick={(e) => {
								e.stopPropagation();
								emitDataChanged("worktrees"); // reloads sidebar list, branches, sync bar
								router.invalidate(); // reloads the project view's worktree grid
							}}
							data-tip="Rescan worktrees"
							data-tip-align="end"
							aria-label="Rescan worktrees"
						>
							<RefreshIcon size={13} />
						</button>
						{status.attention.projects.has(project.id) ? (
							<span className={styles.attentionDot} title="a chat here needs your answer" />
						) : status.working.projects.has(project.id) ? (
							<span className={styles.workingDot} title="a chat here is working" />
						) : status.unread.projects.has(project.id) ? (
							<span className={styles.unreadDot} title="a chat here finished — unread" />
						) : (
							chatProjects.has(project.id) && (
								<span className={styles.resumeDot} title="a chat here" />
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
								editingId === wt.id ? (
									<div className={styles.worktree} data-active={params.worktreeId === wt.id || undefined}>
										<input
											className={styles.worktreeInput}
											value={draft}
											autoFocus
											onFocus={(e) => e.currentTarget.select()}
											onChange={(e) => setDraft(e.target.value)}
											onBlur={() => commitLabel(wt)}
											onKeyDown={(e) => {
												if (e.key === "Enter") e.currentTarget.blur();
												else if (e.key === "Escape") {
													labelCancelled.current = true;
													setEditingId(null);
												}
											}}
											placeholder={wt.branch ?? "label"}
											aria-label="Worktree label"
											spellCheck={false}
										/>
									</div>
								) : (
								<button
									className={styles.worktree}
									data-active={params.worktreeId === wt.id || undefined}
									onClick={() =>
										navigate({
											to: "/project/$projectId/worktree/$worktreeId",
											params: { projectId: project.id, worktreeId: wt.id },
										})
									}
									onDoubleClick={() => {
										labelCancelled.current = false;
										setDraft(wt.name ?? wt.branch ?? "");
										setEditingId(wt.id);
									}}
									title={`${wt.path}\nDouble-click to set a label`}
								>
									<span className={styles.worktreeBranch}>
										{wt.isPrimary && (
											<span className={styles.primaryMark} title="primary worktree">
												<SproutIcon size={14} />
											</span>
										)}
										<span className={styles.worktreeLabel}>
											{worktreeLabel(wt).label}
											{/* A label hides the branch, and "detached" says nothing about what
											    it is — keep the real branch / state visible. */}
											{worktreeLabel(wt).note && (
												<span className={styles.worktreeRealBranch}>({worktreeLabel(wt).note})</span>
											)}
										</span>
									</span>
									<span className={styles.worktreeTime}>{relativeTime(wt.lastActivityAt)}</span>
									{status.attention.worktrees.has(wt.id) ? (
										<span className={styles.attentionDot} title="needs your answer" />
									) : status.working.worktrees.has(wt.id) ? (
										<span className={styles.workingDot} title="working" />
									) : status.unread.worktrees.has(wt.id) ? (
										<span className={styles.unreadDot} title="finished — unread" />
									) : chatWorktrees.has(wt.id) ? (
										<span className={styles.resumeDot} title="a chat here" />
									) : null}
								</button>
								)
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

			<NewWorktreeDialog
				open={newOpen}
				onOpenChange={setNewOpen}
				projectId={project.id}
				onCreated={onWorktreeCreated}
			/>
			<ReviewDialog
				open={reviewOpen}
				onOpenChange={setReviewOpen}
				projectId={project.id}
				onSubmit={startReview}
			/>
		</Collapsible.Root>
	);
}
