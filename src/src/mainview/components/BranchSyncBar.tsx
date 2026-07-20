import { useCallback, useEffect, useState } from "react";
import type { CommitSummary } from "../../shared/types";
import { api, emitDataChanged, onDataChanged } from "../rpc";
import { notify } from "../lib/toast";
import { Button } from "./ui/Button";
import { DownloadIcon, GitBranchIcon } from "./icons";
import styles from "./BranchSyncBar.module.css";

type Status = {
	branch: string | null;
	ahead: number;
	behind: number;
	hasRemote: boolean;
	recent: CommitSummary[];
};

/** Shows whether the project's base branch is behind origin, with an Update action. */
export function BranchSyncBar({ projectId }: { projectId: string }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const load = useCallback(() => {
		api.branchStatus({ projectId }).then(setStatus);
	}, [projectId]);

	useEffect(() => {
		load();
		const off = onDataChanged((scope) => {
			if (scope === "worktrees") load();
		});
		return () => {
			off();
		};
	}, [load]);

	if (!status || !status.hasRemote || !status.branch) return null;

	async function update() {
		if (busy) return; // guard against double-fire while a fetch is in flight
		setBusy(true);
		try {
			const res = await api.fetchProject({ projectId });
			if (!res.ok) {
				notify(`Fetch failed${res.error ? `: ${res.error}` : ""}`, "error");
				return;
			}
			load();
			emitDataChanged("worktrees");
			notify(`Fetched ${status?.branch}`);
		} catch (err) {
			notify(`Fetch failed: ${String(err)}`, "error");
		} finally {
			setBusy(false);
		}
	}

	const behind = status.behind;
	return (
		<div className={styles.bar} data-behind={behind > 0 || undefined}>
			<div className={styles.row}>
				<GitBranchIcon size={14} />
				<span className={styles.branch}>{status.branch}</span>
				<span className={styles.state}>
					{behind > 0 ? `${behind} behind origin` : "up to date with origin"}
					{status.ahead > 0 ? ` · ${status.ahead} ahead` : ""}
				</span>
				<Button
					variant={behind > 0 ? "primary" : "ghost"}
					icon={<DownloadIcon size={14} />}
					onClick={update}
					disabled={busy}
				>
					{busy ? "Fetching…" : behind > 0 ? "Update" : "Fetch"}
				</Button>
			</div>
			{status.recent.length > 0 && (
				<div className={styles.recent}>
					{(expanded ? status.recent : status.recent.slice(0, 3)).map((c) => (
						<div key={c.hash} className={styles.commit} title={`${c.subject} — ${c.author}`}>
							<code className={styles.commitHash}>{c.hash}</code>
							<span className={styles.commitSubject}>{c.subject}</span>
							<span className={styles.commitAuthor}>{c.author}</span>
							<span className={styles.commitTime}>{c.relative}</span>
						</div>
					))}
					{status.recent.length > 3 && (
						<button className={styles.more} onClick={() => setExpanded((v) => !v)}>
							{expanded ? "Show less" : `Show ${status.recent.length - 3} more`}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
