import { useCallback, useEffect, useState } from "react";
import { api, emitDataChanged } from "../rpc";
import { notify } from "../lib/toast";
import { Button } from "./ui/Button";
import { DownloadIcon, GitBranchIcon } from "./icons";
import styles from "./BranchSyncBar.module.css";

type Status = {
	branch: string | null;
	ahead: number;
	behind: number;
	hasRemote: boolean;
};

/** Shows whether the project's base branch is behind origin, with an Update action. */
export function BranchSyncBar({ projectId }: { projectId: string }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(() => {
		api.branchStatus({ projectId }).then(setStatus);
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	if (!status || !status.hasRemote || !status.branch) return null;

	async function update() {
		setBusy(true);
		const res = await api.fetchProject({ projectId });
		setBusy(false);
		if (!res.ok) {
			notify(`Fetch failed${res.error ? `: ${res.error}` : ""}`, "error");
			return;
		}
		load();
		emitDataChanged("worktrees");
		notify(`Fetched ${status?.branch}`);
	}

	const behind = status.behind;
	return (
		<div className={styles.bar} data-behind={behind > 0 || undefined}>
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
	);
}
