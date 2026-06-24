import { indexRoute, rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { WorktreeCard } from "../components/WorktreeCard";
import { ClockIcon } from "../components/icons";
import tb from "../components/Titlebar.module.css";
import styles from "./Page.module.css";

export function RecentView() {
	const worktrees = indexRoute.useLoaderData();
	const projects = rootRoute.useLoaderData();

	return (
		<div className={styles.view}>
			<Titlebar>
				<ClockIcon size={15} /> Recent worktrees
				{projects.length > 0 && (
					<span className={tb.muted}>
						· {projects.length} project{projects.length === 1 ? "" : "s"}
					</span>
				)}
			</Titlebar>

			<div className={styles.scroll}>
				{projects.length === 0 ? (
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
				) : (
					<div className={styles.page}>
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
				)}
			</div>
		</div>
	);
}
