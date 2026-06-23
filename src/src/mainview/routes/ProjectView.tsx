import { projectRoute, rootRoute } from "../router";
import { WorktreeCard } from "../components/WorktreeCard";
import { FolderIcon, RevealIcon } from "../components/icons";
import { tildePath } from "../lib/format";
import { api } from "../rpc";
import styles from "./Page.module.css";

export function ProjectView() {
	const worktrees = projectRoute.useLoaderData();
	const { projectId } = projectRoute.useParams();
	const projects = rootRoute.useLoaderData();
	const project = projects.find((p) => p.id === projectId);

	if (!project) {
		return (
			<div className={styles.page}>
				<p className={styles.hint}>This project is no longer available.</p>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<div className={styles.titleRow}>
					<h1>
						<FolderIcon size={20} /> {project.name}
					</h1>
					<button
						className={styles.ghostButton}
						onClick={() => api.revealInFinder({ path: project.path })}
					>
						<RevealIcon /> Reveal
					</button>
				</div>
				<p className={styles.subtitle}>
					{tildePath(project.path)} · {worktrees.length} worktree
					{worktrees.length === 1 ? "" : "s"}
				</p>
			</header>

			{worktrees.length === 0 ? (
				<p className={styles.hint}>No worktrees found for this project.</p>
			) : (
				<div className={styles.grid}>
					{worktrees.map((wt) => (
						<WorktreeCard key={wt.id} worktree={wt} />
					))}
				</div>
			)}
		</div>
	);
}
