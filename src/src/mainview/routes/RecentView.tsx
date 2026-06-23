import { indexRoute, rootRoute } from "../router";
import { WorktreeCard } from "../components/WorktreeCard";
import { ClockIcon } from "../components/icons";
import styles from "./Page.module.css";

export function RecentView() {
	const worktrees = indexRoute.useLoaderData();
	const projects = rootRoute.useLoaderData();

	if (projects.length === 0) {
		return (
			<div className={styles.page}>
				<div className={styles.emptyState}>
					<ClockIcon size={28} />
					<h2>No projects yet</h2>
					<p>
						Add a git repository from the sidebar. Forest Ranger will track its
						worktrees and surface the ones you touched most recently.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className={styles.page}>
			<header className={styles.header}>
				<h1>Recent worktrees</h1>
				<p className={styles.subtitle}>
					Across {projects.length} project{projects.length === 1 ? "" : "s"}, most
					recently active first.
				</p>
			</header>

			{worktrees.length === 0 ? (
				<p className={styles.hint}>No worktrees found in your projects yet.</p>
			) : (
				<div className={styles.grid}>
					{worktrees.map((wt) => (
						<WorktreeCard key={wt.id} worktree={wt} projectName={wt.projectName} />
					))}
				</div>
			)}
		</div>
	);
}
