import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorktreeWithProject } from "../../shared/types";
import { api } from "../rpc";
import { rootRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { HomeIcon, TerminalIcon } from "../components/icons";
import { useChatStatus } from "../lib/attentionStore";
import { setActiveSession, useTerminals, type TermSession } from "../lib/terminalStore";
import { relativeTime, tildePath } from "../lib/format";
import { worktreeLabel } from "../lib/worktreeLabel";
import tb from "../components/Titlebar.module.css";
import page from "./Page.module.css";
import styles from "./HomeView.module.css";

/** Recent worktrees shown under the inbox — a short "where was I", not every one. */
const RECENT_COUNT = 10;

type Dot = "attention" | "unread" | "working" | "command";

/**
 * Home: what needs you, then where you were. Chats waiting on an answer, chats
 * that finished since you last looked, what's running, and a short list of recent
 * worktrees. Replaces the old Recent (a wall of identical cards) and Activity
 * (every open tab listed as "running") pages.
 */
export function HomeView() {
	const projects = rootRoute.useLoaderData();
	// Fetched after first paint (see the index route): null until it arrives. All of
	// them, so chats in any worktree get a label; Recent shows the top few.
	const [worktrees, setWorktrees] = useState<WorktreeWithProject[] | null>(null);
	useEffect(() => {
		let live = true;
		api.recentWorktrees({ limit: 500 }).then((w) => live && setWorktrees(w));
		return () => {
			live = false;
		};
	}, []);
	const navigate = useNavigate();
	const { sessions } = useTerminals();
	const status = useChatStatus();

	const byId = new Map((worktrees ?? []).map((w) => [w.id, w]));
	const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
	const sessionWorktree = (s: TermSession) => {
		const wt = byId.get(s.worktreeId);
		if (wt) return worktreeLabel(wt).label;
		const i = s.title.indexOf(" · "); // session titles are "branch · label"
		return i === -1 ? s.title : s.title.slice(0, i);
	};
	const sessionLabel = (s: TermSession) => {
		if (s.name) return s.name;
		const i = s.title.indexOf(" · ");
		return i === -1 ? s.title : s.title.slice(i + 3);
	};

	// Chat status is keyed by the chat's own id (same as ChatPane's chatId).
	const sid = (s: TermSession) => s.sessionId ?? s.id;
	const chats = sessions.filter((s) => s.kind === "chat");
	const waiting = chats.filter((s) => status.attention.sessions.has(sid(s)));
	const notWaiting = (s: TermSession) => !status.attention.sessions.has(sid(s));
	const unread = chats.filter((s) => status.unread.sessions.has(sid(s)) && notWaiting(s));
	const working = chats.filter((s) => status.working.sessions.has(sid(s)) && notWaiting(s));
	// Run commands (dev servers, builds) count as work; a plain shell tab doesn't.
	const commands = sessions.filter(
		(s) => s.kind === "terminal" && s.running && (s.command || s.commandId),
	);
	const caughtUp = waiting.length + unread.length + working.length + commands.length === 0;

	function openSession(s: TermSession) {
		setActiveSession(s.id);
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId: s.projectId, worktreeId: s.worktreeId },
		});
	}

	const sessionRows = (list: TermSession[], dot: Dot) =>
		list.map((s) => (
			<Row
				key={s.id}
				dot={dot}
				title={sessionLabel(s)}
				sub={`${sessionWorktree(s)} · ${projectName(s.projectId)}`}
				onClick={() => openSession(s)}
			/>
		));

	if (projects.length === 0) {
		return (
			<div className={page.view}>
				<Titlebar>
					<HomeIcon /> Home
				</Titlebar>
				<div className={page.scroll}>
					<div className={page.page}>
						<div className={page.emptyState}>
							<HomeIcon size={28} />
							<h2>No projects yet</h2>
							<p>
								Add a git repository from the sidebar. Chats that need you and the
								worktrees you were in will show up here.
							</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className={page.view}>
			<Titlebar>
				<HomeIcon /> Home
				{waiting.length > 0 && (
					<span className={tb.muted}>· {waiting.length} waiting on you</span>
				)}
			</Titlebar>

			<div className={page.scroll}>
				<div className={styles.page}>
					{caughtUp ? (
						<p className={styles.caughtUp}>All caught up — nothing is waiting on you.</p>
					) : (
						<>
							<Section title="Waiting on you" count={waiting.length}>
								{sessionRows(waiting, "attention")}
							</Section>
							<Section title="Finished" count={unread.length}>
								{sessionRows(unread, "unread")}
							</Section>
							<Section title="Working" count={working.length + commands.length}>
								{sessionRows(working, "working")}
								{sessionRows(commands, "command")}
							</Section>
						</>
					)}

					{worktrees === null && <p className={styles.caughtUp}>Loading recent worktrees…</p>}
					<Section title="Recent" count={worktrees?.length ?? 0}>
						{(worktrees ?? []).slice(0, RECENT_COUNT).map((wt) => (
							<Row
								key={wt.id}
								title={worktreeLabel(wt).label}
								sub={[worktreeLabel(wt).note, wt.projectName].filter(Boolean).join(" · ")}
								hint={tildePath(wt.path)}
								meta={wt.dirty ? `${wt.dirty} changed` : undefined}
								time={relativeTime(wt.lastActivityAt)}
								onClick={() =>
									navigate({
										to: "/project/$projectId/worktree/$worktreeId",
										params: { projectId: wt.projectId, worktreeId: wt.id },
									})
								}
							/>
						))}
					</Section>
				</div>
			</div>
		</div>
	);
}

function Section({
	title,
	count,
	children,
}: {
	title: string;
	count: number;
	children: React.ReactNode;
}) {
	if (count === 0) return null;
	return (
		<section className={styles.section}>
			<h2 className={styles.sectionTitle}>{title}</h2>
			<div className={styles.list}>{children}</div>
		</section>
	);
}

function Row({
	dot,
	title,
	sub,
	hint,
	meta,
	time,
	onClick,
}: {
	dot?: Dot;
	title: string;
	sub: string;
	hint?: string;
	meta?: string;
	time?: string;
	onClick: () => void;
}) {
	return (
		<button className={styles.row} onClick={onClick} title={hint}>
			{dot === "command" ? (
				<span className={styles.icon}>
					<TerminalIcon size={13} />
				</span>
			) : (
				<span className={styles.dotSlot}>{dot && <span className={styles.dot} data-kind={dot} />}</span>
			)}
			<span className={styles.title}>{title}</span>
			<span className={styles.sub}>{sub}</span>
			{meta && <span className={styles.meta}>{meta}</span>}
			{time && <span className={styles.time}>{time}</span>}
		</button>
	);
}
