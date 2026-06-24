import { useNavigate } from "@tanstack/react-router";
import type { Worktree } from "../../shared/types";
import { api } from "../rpc";
import { relativeTime, shortHash, tildePath } from "../lib/format";
import { GitBranchIcon, RevealIcon } from "./icons";
import { OpenItems, RowMenu } from "./RowMenu";
import styles from "./WorktreeCard.module.css";

export function WorktreeCard({
	worktree,
	projectName,
}: {
	worktree: Worktree;
	projectName?: string;
}) {
	const navigate = useNavigate();

	function open() {
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId: worktree.projectId, worktreeId: worktree.id },
		});
	}

	function goToProject(e: React.MouseEvent) {
		e.stopPropagation();
		navigate({
			to: "/project/$projectId",
			params: { projectId: worktree.projectId },
		});
	}

	function reveal(e: React.MouseEvent) {
		e.stopPropagation();
		api.revealInFinder({ path: worktree.path });
	}

	return (
		<RowMenu
			trigger={
				<button className={styles.card} onClick={open} title="View worktree">
					<CardBody worktree={worktree} projectName={projectName} goToProject={goToProject} reveal={reveal} />
				</button>
			}
		>
			<OpenItems path={worktree.path} />
		</RowMenu>
	);
}

function CardBody({
	worktree,
	projectName,
	goToProject,
	reveal,
}: {
	worktree: Worktree;
	projectName?: string;
	goToProject: (e: React.MouseEvent) => void;
	reveal: (e: React.MouseEvent) => void;
}) {
	return (
		<>
			<div className={styles.top}>
				<span className={styles.branch}>
					<GitBranchIcon />
					{worktree.branch ?? "detached"}
				</span>
				<div className={styles.badges}>
					{worktree.isPrimary && <span className={styles.primary}>primary</span>}
					{worktree.isDetached && <span className={styles.detached}>detached</span>}
					{worktree.isLocked && <span className={styles.locked}>locked</span>}
				</div>
			</div>

			<div className={styles.path} title={worktree.path}>
				{projectName && (
					<span className={styles.project} onClick={goToProject} title="Go to project">
						{projectName}
					</span>
				)}
				{tildePath(worktree.path)}
			</div>

			<div className={styles.meta}>
				<span className={styles.hash}>{shortHash(worktree.head)}</span>
				<span className={styles.dot}>·</span>
				<span>{relativeTime(worktree.lastActivityAt)}</span>
				<span className={styles.spacer} />
				<span className={styles.reveal} onClick={reveal} title="Reveal in Finder">
					<RevealIcon />
				</span>
			</div>
		</>
	);
}
