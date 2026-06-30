import { useEffect, useState } from "react";
import type { BranchIntegrations } from "../../shared/types";
import { api } from "../rpc";
import styles from "./BranchIntegrationBar.module.css";

/** Map a GitLab pipeline status to a tone + label. */
function pipelineTone(status: string): { tone: string; label: string } {
	switch (status) {
		case "success":
			return { tone: "ok", label: "passed" };
		case "failed":
			return { tone: "bad", label: "failed" };
		case "running":
			return { tone: "run", label: "running" };
		case "pending":
		case "created":
		case "preparing":
		case "waiting_for_resource":
		case "scheduled":
			return { tone: "warn", label: "pending" };
		default:
			return { tone: "mute", label: status.replace(/_/g, " ") };
	}
}

function mrTone(state: string): string {
	if (state === "opened") return "ok";
	if (state === "merged") return "done";
	if (state === "closed") return "bad";
	return "mute";
}

export function BranchIntegrationBar({
	projectId,
	branch,
}: {
	projectId: string;
	branch: string;
}) {
	const [data, setData] = useState<BranchIntegrations | null>(null);

	useEffect(() => {
		let live = true;
		setData(null);
		api.branchIntegrations({ projectId, branch }).then((d) => {
			if (live) setData(d);
		});
		return () => {
			live = false;
		};
	}, [projectId, branch]);

	const gl = data?.gitlab;
	if (!gl) return null;

	const open = (url: string | null) => url && api.openUrl({ url });

	return (
		<div className={styles.bar}>
			<span className={styles.provider}>GitLab</span>

			{gl.mr ? (
				<button
					className={styles.badge}
					data-tone={mrTone(gl.mr.state)}
					onClick={() => open(gl.mr!.url)}
					title={gl.mr.title}
				>
					MR !{gl.mr.iid} · {gl.mr.state}
				</button>
			) : (
				!gl.error && <span className={styles.muted}>No open MR</span>
			)}

			{gl.pipeline &&
				(() => {
					const { tone, label } = pipelineTone(gl.pipeline.status);
					return (
						<button
							className={styles.badge}
							data-tone={tone}
							onClick={() => open(gl.pipeline!.url)}
							title={`Pipeline: ${gl.pipeline.status}`}
						>
							<span className={styles.dot} /> pipeline {label}
						</button>
					);
				})()}

			{gl.error && (
				<span className={styles.error} title={gl.error}>
					unavailable
				</span>
			)}

			{gl.projectUrl && (
				<button className={styles.link} onClick={() => open(gl.projectUrl)}>
					Open in GitLab ↗
				</button>
			)}
		</div>
	);
}
