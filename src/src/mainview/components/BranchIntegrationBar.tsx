import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { BranchIntegrations, IntegrationType } from "../../shared/types";
import { api, emitDataChanged } from "../rpc";
import { notify } from "../lib/toast";
import styles from "./BranchIntegrationBar.module.css";

const PROVIDER: Record<IntegrationType, { name: string; reqPrefix: string; checks: string }> = {
	github: { name: "GitHub", reqPrefix: "PR #", checks: "checks" },
	gitlab: { name: "GitLab", reqPrefix: "MR !", checks: "pipeline" },
};

/** Map a normalized checks status to a tone + label. */
function checksTone(status: string): { tone: string; label: string } {
	switch (status) {
		case "success":
			return { tone: "ok", label: "passed" };
		case "failed":
			return { tone: "bad", label: "failed" };
		case "running":
			return { tone: "run", label: "running" };
		case "pending":
			return { tone: "warn", label: "pending" };
		default:
			return { tone: "mute", label: status.replace(/_/g, " ") };
	}
}

function requestTone(state: string): string {
	if (state === "open") return "ok";
	if (state === "merged") return "done";
	if (state === "closed") return "bad";
	return "mute";
}

export function BranchIntegrationBar({
	projectId,
	worktreeId,
	branch,
	base,
}: {
	projectId: string;
	worktreeId: string;
	branch: string;
	base: string | null;
}) {
	const [data, setData] = useState<BranchIntegrations | null>(null);
	const [creating, setCreating] = useState(false);
	const router = useRouter();

	function load() {
		let live = true;
		setData(null);
		api.branchIntegrations({ projectId, branch }).then((d) => {
			if (live) setData(d);
		});
		return () => {
			live = false;
		};
	}
	useEffect(load, [projectId, branch]);

	if (!data) return null;

	const p = PROVIDER[data.provider];
	const open = (url: string | null) => url && api.openUrl({ url });
	const { request, checks } = data;

	async function create() {
		if (!base || creating) return;
		setCreating(true);
		const res = await api.createReviewRequest({ id: worktreeId, base, title: branch });
		setCreating(false);
		if (res.ok) {
			notify(`Opened ${p.reqPrefix}${res.number}`);
			open(res.url ?? null);
			emitDataChanged("worktrees");
			router.invalidate();
			load();
		} else {
			notify(res.error ?? "Failed to open request", "error");
		}
	}

	return (
		<div className={styles.bar}>
			<span className={styles.provider}>{p.name}</span>

			{request ? (
				<button
					className={styles.badge}
					data-tone={requestTone(request.state)}
					onClick={() => open(request.url)}
					title={request.title}
				>
					{p.reqPrefix}
					{request.number} · {request.state}
				</button>
			) : (
				!data.error &&
				(base ? (
					<button className={styles.link} onClick={create} disabled={creating}>
						{creating ? "Opening…" : `Push & open ${p.reqPrefix.trim()}`}
					</button>
				) : (
					<span className={styles.muted}>No open {p.reqPrefix.trim()}</span>
				))
			)}

			{checks &&
				(() => {
					const { tone, label } = checksTone(checks.status);
					return (
						<button
							className={styles.badge}
							data-tone={tone}
							onClick={() => open(checks.url)}
							title={`${p.checks}: ${checks.status}`}
						>
							<span className={styles.dot} /> {p.checks} {label}
						</button>
					);
				})()}

			{data.error && (
				<span className={styles.error} title={data.error}>
					unavailable
				</span>
			)}

			{data.projectUrl && (
				<button className={styles.link} onClick={() => open(data.projectUrl)}>
					Open in {p.name} ↗
				</button>
			)}
		</div>
	);
}
