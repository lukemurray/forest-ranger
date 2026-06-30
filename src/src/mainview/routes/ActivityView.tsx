import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { Button } from "../components/ui/Button";
import { ActivityIcon, GitBranchIcon, TerminalIcon } from "../components/icons";
import { bus } from "../rpc";
import {
	setActiveSession,
	useTerminals,
	type TermSession,
} from "../lib/terminalStore";
import { elapsed } from "../lib/format";
import tb from "../components/Titlebar.module.css";
import styles from "./ActivityView.module.css";

export function ActivityView() {
	const projects = rootRoute.useLoaderData();
	const navigate = useNavigate();
	const { sessions } = useTerminals();
	const running = sessions.filter((s) => s.running);

	// Re-render once a second so elapsed times tick.
	const [, force] = useState(0);
	useEffect(() => {
		if (running.length === 0) return;
		const t = setInterval(() => force((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, [running.length]);

	const projectName = (id: string) =>
		projects.find((p) => p.id === id)?.name ?? "project";

	function open(s: TermSession) {
		setActiveSession(s.id);
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId: s.projectId, worktreeId: s.worktreeId },
		});
	}
	function stop(s: TermSession) {
		if (s.kind === "chat") bus.agentChatStop({ sessionId: s.sessionId ?? s.id });
		else bus.termKill({ sessionId: s.id });
	}

	return (
		<div className={styles.view}>
			<Titlebar>
				<ActivityIcon size={15} /> Activity
				{running.length > 0 && (
					<span className={tb.muted}>
						· {running.length} running
					</span>
				)}
			</Titlebar>

			<div className={styles.scroll}>
				<div className={styles.page}>
					{running.length === 0 ? (
						<div className={styles.emptyState}>
							<ActivityIcon size={28} />
							<h2>Nothing running</h2>
							<p>
								Launch an agent or a run command in a worktree and it'll show up
								here with how long it's been going. Only in-app terminals are
								tracked.
							</p>
						</div>
					) : (
						<div className={styles.list}>
							{running.map((s) => {
								const [branch, label] = splitTitle(s.title);
								return (
									<div key={s.id} className={styles.card}>
										<span className={styles.pulse} title="running" />
										<div className={styles.meta}>
											<div className={styles.label}>{s.name ?? label ?? branch}</div>
											<div className={styles.sub}>
												<span className={styles.project}>{projectName(s.projectId)}</span>
												<span className={styles.branch}>
													<GitBranchIcon size={12} /> {branch}
												</span>
											</div>
										</div>
										<div className={styles.elapsed} title="elapsed">
											{elapsed(s.startedAt)}
										</div>
										<div className={styles.actions}>
											<Button variant="subtle" icon={<TerminalIcon size={13} />} onClick={() => open(s)}>
												Open
											</Button>
											<Button variant="danger" onClick={() => stop(s)}>
												Stop
											</Button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** Sessions title as "branch · label"; split back into the two parts. */
function splitTitle(title: string): [string, string | null] {
	const i = title.indexOf(" · ");
	return i === -1 ? [title, null] : [title.slice(0, i), title.slice(i + 3)];
}
