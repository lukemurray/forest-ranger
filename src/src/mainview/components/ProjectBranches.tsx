import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BranchSummary } from "../../shared/types";
import { api, onDataChanged } from "../rpc";
import { relativeTime } from "../lib/format";
import { notify } from "../lib/toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { FolderIcon, GitBranchIcon, PlusIcon, TrashIcon } from "./icons";
import styles from "./ProjectBranches.module.css";

/** Collapsed groups show at most this many rows until "show all" (ignored while searching). */
const CAP = 12;

const GROUPS: { key: string; label: string; match: (b: BranchSummary) => boolean }[] = [
	{ key: "local", label: "Local only", match: (b) => b.local && !b.remote },
	{ key: "both", label: "Local & origin", match: (b) => b.local && b.remote },
	{ key: "origin", label: "Origin only", match: (b) => !b.local && b.remote },
];

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function ProjectBranches({
	projectId,
	onCreated,
}: {
	projectId: string;
	onCreated: (worktreeId: string, path: string, startChat: boolean) => void;
}) {
	const navigate = useNavigate();
	const [branches, setBranches] = useState<BranchSummary[]>([]);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState<string | null>(null);
	// A branch whose safe-delete was refused (unmerged) → confirm force delete.
	const [forceDelete, setForceDelete] = useState<BranchSummary | null>(null);
	const [cleanupOpen, setCleanupOpen] = useState(false);

	// Local branches fully merged into the base, with no worktree — safe to prune.
	const merged = branches.filter(
		(b) => b.local && b.worktrees.length === 0 && b.ahead === 0 && b.name !== b.base,
	);

	const load = useCallback(() => {
		api.projectBranchGraph({ projectId }).then(setBranches);
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

	async function create(b: BranchSummary) {
		setBusy(b.name);
		const res = await api.createWorktree({
			projectId,
			name: b.local ? b.name : "",
			base: b.local ? b.name : `origin/${b.name}`,
			location: null,
		});
		setBusy(null);
		if (res.ok && res.worktreeId && res.path) {
			onCreated(res.worktreeId, res.path, false);
		} else {
			notify(`Couldn't create worktree${res.error ? `: ${res.error}` : ""}`, "error");
		}
	}

	async function del(b: BranchSummary, force: boolean) {
		setBusy(b.name);
		const res = await api.deleteBranch({ projectId, branch: b.name, force });
		setBusy(null);
		if (res.ok) {
			load();
			return;
		}
		// -d refuses unmerged branches → offer a force confirm rather than erroring.
		if (!force && /not (fully )?merged/i.test(res.error ?? "")) {
			setForceDelete(b);
		} else {
			notify(`Couldn't delete branch${res.error ? `: ${res.error}` : ""}`, "error");
		}
	}

	async function cleanupMerged() {
		const names = merged.map((b) => b.name);
		const res = await api.deleteBranches({ projectId, branches: names, force: false });
		load();
		const skipped = res.failed.length ? `, ${res.failed.length} skipped` : "";
		notify(`Deleted ${res.deleted.length} merged branch${res.deleted.length === 1 ? "" : "es"}${skipped}`);
	}

	function goWorktree(worktreeId: string) {
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId },
		});
	}

	const q = query.trim().toLowerCase();
	const filtered = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;

	return (
		<section className={styles.section}>
			<div className={styles.head}>
				<h2 className={styles.title}>Branches</h2>
				<span className={styles.total}>{branches.length}</span>
				<input
					className={styles.search}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter branches…"
					spellCheck={false}
				/>
				{merged.length > 0 && (
					<button
						className={styles.cleanup}
						onClick={() => setCleanupOpen(true)}
						title="Delete local branches fully merged into the base"
					>
						<TrashIcon size={13} /> Clean up {merged.length}
					</button>
				)}
			</div>

			{filtered.length === 0 ? (
				<p className={styles.hint}>{branches.length === 0 ? "No branches found." : "No matches."}</p>
			) : (
				GROUPS.map((g) => {
					const items = filtered
						.filter(g.match)
						.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
					if (items.length === 0) return null;
					const capped = !q && !expanded[g.key] && items.length > CAP;
					const shown = capped ? items.slice(0, CAP) : items;
					return (
						<div key={g.key} className={styles.group}>
							<div className={styles.groupHead}>
								{g.label} <span className={styles.count}>{items.length}</span>
							</div>
							<ul className={styles.list}>
								{shown.map((b) => (
									<BranchRow
										key={b.name}
										branch={b}
										busy={busy === b.name}
										onCreate={() => create(b)}
										onDelete={() => del(b, false)}
										onGoWorktree={goWorktree}
										baseName={baseName}
									/>
								))}
							</ul>
							{capped && (
								<button
									className={styles.showAll}
									onClick={() => setExpanded((e) => ({ ...e, [g.key]: true }))}
								>
									Show all {items.length}
								</button>
							)}
						</div>
					);
				})
			)}

			<ConfirmDialog
				open={forceDelete !== null}
				onOpenChange={(o) => !o && setForceDelete(null)}
				title="Force-delete branch?"
				description={
					forceDelete
						? `"${forceDelete.name}" has commits not merged into ${forceDelete.base ?? "the base branch"}. Deleting it discards that work permanently.`
						: ""
				}
				confirmLabel="Force delete"
				danger
				onConfirm={() => {
					if (forceDelete) del(forceDelete, true);
					setForceDelete(null);
				}}
			/>

			<ConfirmDialog
				open={cleanupOpen}
				onOpenChange={setCleanupOpen}
				title={`Clean up ${merged.length} merged branch${merged.length === 1 ? "" : "es"}?`}
				description={`Deletes local branches fully merged into ${merged[0]?.base ?? "the base branch"} with no worktree. Unmerged branches are left untouched, so no work is lost.`}
				confirmLabel="Delete merged"
				danger
				onConfirm={cleanupMerged}
			/>
		</section>
	);
}

function BranchRow({
	branch: b,
	busy,
	onCreate,
	onDelete,
	onGoWorktree,
	baseName,
}: {
	branch: BranchSummary;
	busy: boolean;
	onCreate: () => void;
	onDelete: () => void;
	onGoWorktree: (id: string) => void;
	baseName: (p: string) => string;
}) {
	const diverged = b.ahead != null && (b.ahead > 0 || (b.behind ?? 0) > 0);
	return (
		<li className={styles.row}>
			<GitBranchIcon size={14} />
			<span className={styles.name} title={b.name}>{b.name}</span>
			{b.remote && <span className={styles.originChip}>origin</span>}
			{diverged && (
				<span
					className={styles.diverge}
					title={`${b.ahead} ahead / ${b.behind} behind ${b.base ?? "base"}`}
				>
					{(b.ahead ?? 0) > 0 && <span className={styles.ahead}>↑{b.ahead}</span>}
					{(b.behind ?? 0) > 0 && <span className={styles.behind}>↓{b.behind}</span>}
				</span>
			)}
			{b.lastCommitAt != null && (
				<span className={styles.time}>{relativeTime(b.lastCommitAt)}</span>
			)}
			<span className={styles.spacer} />
			{b.worktrees.length > 0 ? (
				<span className={styles.linked}>
					{b.worktrees.map((w) => (
						<button
							key={w.id}
							className={styles.wtChip}
							onClick={() => onGoWorktree(w.id)}
							title={w.path}
						>
							<FolderIcon size={12} /> {baseName(w.path)}
						</button>
					))}
				</span>
			) : (
				<span className={styles.actions}>
					<button
						className={styles.create}
						disabled={busy}
						onClick={onCreate}
						title={`Create a worktree for ${b.name}`}
					>
						<PlusIcon size={13} /> Worktree
					</button>
					{b.local && (
						<button
							className={styles.trash}
							disabled={busy}
							onClick={onDelete}
							title="Delete branch"
						>
							<TrashIcon size={14} />
						</button>
					)}
				</span>
			)}
		</li>
	);
}
