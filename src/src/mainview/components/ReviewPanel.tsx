import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import type {
	ChangedFile,
	ChangeKind,
	ListedCommit,
	WorktreeDetail,
} from "../../shared/types";
import { openDiff, openFile } from "../lib/terminalStore";
import { setPanelView, usePanel } from "../lib/panelStore";
import { BranchCombobox } from "./BranchCombobox";
import { Dropdown, DropdownItem } from "./Dropdown";
import { BranchIntegrationBar } from "./BranchIntegrationBar";
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from "./icons";
import { api, emitDataChanged } from "../rpc";
import { openSession } from "../lib/terminalStore";
import { providerLabel, useChatConfig } from "../lib/chatConfig";
import { notify } from "../lib/toast";
import { relativeTime, shortHash } from "../lib/format";
import styles from "./ReviewPanel.module.css";

/** Staging controls passed down to the uncommitted file rows. */
type Staging = {
	isStaged: (path: string) => boolean;
	onToggle: (path: string) => void;
	onSetMany: (paths: string[], staged: boolean) => void;
};

/** The instruction an "Agent merge" chat is seeded with. */
function mergePrompt(base: string, branch: string): string {
	return `Merge the latest \`${base}\` into this branch (\`${branch}\`) and resolve any conflicts.

1. Fetch and merge (\`git fetch\` then \`git merge origin/${base}\`).
2. If there are conflicts:
   - Resolve simple, unambiguous conflicts directly.
   - For conflicts in generated files (build output, lockfiles, generated code, snapshots), don't hand-merge — regenerate them by running the project's codegen/build command, then stage the result.
   - If a conflict is non-trivial or you're unsure, STOP and ask me for direction instead of guessing.
3. When done:
   - If the ONLY conflicts were in generated files, complete the merge commit and push.
   - Otherwise, leave your resolutions staged but do NOT commit — I want to review locally first — and summarize what changed.
4. Ask me before doing anything risky.`;
}

const KIND_LABEL: Record<ChangeKind, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "U",
	typechange: "T",
	conflicted: "C",
};

/** The "review" side panel: change summary, integration status, and file diffs. */
export function ReviewPanel({
	detail,
	projectId,
	onSelectBase,
}: {
	detail: WorktreeDetail;
	projectId: string;
	onSelectBase: (base: string) => void;
}) {
	const { worktree, branch, upstream, upstreamAhead, upstreamBehind, base, branches, ahead, behind, committed, uncommitted } =
		detail;
	const router = useRouter();
	const chatConfig = useChatConfig();
	const [optimistic, setOptimistic] = useState<Map<string, boolean>>(new Map());
	const [message, setMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [changesView, setChangesView] = useState<"files" | "commits">("files");
	const { view: panelView } = usePanel();

	// Drop optimistic overrides once fresh data (with real staged flags) arrives.
	const stagedSig = uncommitted.map((f) => `${f.path}:${f.staged ? 1 : 0}`).join("|");
	useEffect(() => {
		setOptimistic(new Map());
	}, [stagedSig]);

	// Keep the change list live as the agent edits/commits: refresh when the window
	// regains focus, and poll gently while it's focused. (invalidate re-runs the
	// worktree loader — git status/log — which is where the changes come from.)
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;
		const stop = () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
		const start = () => {
			if (!timer) timer = setInterval(() => router.invalidate(), 4000);
		};
		const onFocus = () => {
			router.invalidate();
			start();
		};
		if (document.hasFocus()) start();
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", stop);
		return () => {
			stop();
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", stop);
		};
	}, [router]);

	const isStaged = (path: string) => {
		if (optimistic.has(path)) return !!optimistic.get(path);
		return !!uncommitted.find((f) => f.path === path)?.staged;
	};
	const stagedCount = uncommitted.reduce((n, f) => n + (isStaged(f.path) ? 1 : 0), 0);

	async function toggleStage(path: string) {
		const next = !isStaged(path);
		setOptimistic((m) => new Map(m).set(path, next));
		const res = next
			? await api.stageFiles({ id: worktree.id, paths: [path] })
			: await api.unstageFiles({ id: worktree.id, paths: [path] });
		if (!res.ok) notify(res.error ?? "Stage failed", "error");
		router.invalidate();
	}
	async function stageAll(staged: boolean) {
		setOptimistic(new Map(uncommitted.map((f) => [f.path, staged])));
		const res = staged
			? await api.stageFiles({ id: worktree.id, paths: [] })
			: await api.unstageFiles({ id: worktree.id, paths: [] });
		if (!res.ok) notify(res.error ?? "Failed", "error");
		router.invalidate();
	}
	async function setMany(paths: string[], staged: boolean) {
		if (paths.length === 0) return;
		setOptimistic((m) => {
			const n = new Map(m);
			for (const p of paths) n.set(p, staged);
			return n;
		});
		const res = staged
			? await api.stageFiles({ id: worktree.id, paths })
			: await api.unstageFiles({ id: worktree.id, paths });
		if (!res.ok) notify(res.error ?? "Failed", "error");
		router.invalidate();
	}
	async function commit() {
		const msg = message.trim();
		if (!msg || stagedCount === 0 || committing) return;
		setCommitting(true);
		const res = await api.commitChanges({ id: worktree.id, message: msg });
		setCommitting(false);
		if (!res.ok) {
			notify(res.error ?? "Commit failed", "error");
			return;
		}
		setMessage("");
		notify(`Committed ${stagedCount} file${stagedCount === 1 ? "" : "s"}`);
		emitDataChanged("worktrees");
		router.invalidate();
	}

	async function update(mode: "rebase" | "merge") {
		if (!base || updating) return;
		setUpdating(true);
		const res = await api.updateWorktree({ id: worktree.id, base, mode });
		setUpdating(false);
		if (res.ok) {
			notify(`Updated from ${base} (${mode})`);
		} else {
			notify(
				`${mode} hit conflicts — resolve in your editor/terminal: ${res.error ?? ""}`,
				"error",
			);
		}
		// Refresh either way (a conflict leaves the worktree mid-op).
		emitDataChanged("worktrees");
		router.invalidate();
	}

	// Open a chat that merges base in and resolves conflicts per the seeded prompt.
	function agentMerge() {
		if (!base || !branch) return;
		const agent = providerLabel(chatConfig.defaultProvider);
		openSession({
			worktreeId: worktree.id,
			projectId,
			kind: "chat",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: crypto.randomUUID(),
			provider: chatConfig.defaultProvider,
			permissionMode: chatConfig.defaultPermissionMode,
			model: chatConfig.defaultModel,
			agentLabel: agent,
			name: `Merge ${base}`,
			renamed: true,
			title: `${branch} · Merge ${base}`,
			initialPrompt: mergePrompt(base, branch),
		});
	}

	async function push() {
		if (pushing) return;
		setPushing(true);
		const res = await api.pushBranch({ id: worktree.id });
		setPushing(false);
		if (res.ok) notify(`Pushed ${branch ?? "branch"} to origin`);
		else notify(res.error ?? "Push failed", "error");
		emitDataChanged("worktrees");
		router.invalidate();
	}

	// Something to push: no upstream yet, or local commits ahead of it.
	const canPush = !!branch && !worktree.isDetached && (!upstream || upstreamAhead > 0);

	const staging: Staging = { isStaged, onToggle: toggleStage, onSetMany: setMany };

	return (
		<div className={styles.panel}>
			<div className={styles.panelTabs}>
				<button
					className={styles.panelTab}
					data-active={panelView === "review" || undefined}
					onClick={() => setPanelView("review")}
					data-tip="⌘1"
					data-tip-align="end"
				>
					Review
				</button>
				<button
					className={styles.panelTab}
					data-active={panelView === "files" || undefined}
					onClick={() => setPanelView("files")}
					data-tip="⌘2"
					data-tip-align="end"
				>
					Files
				</button>
			</div>
			{panelView === "files" ? (
				<FileBrowser worktreeId={worktree.id} projectId={projectId} />
			) : (
			<div className={styles.scroll}>
				<div className={styles.body}>
					<section className={styles.summary}>
						<div className={styles.stat}>
							<span className={styles.statValue}>{shortHash(worktree.head)}</span>
							<span className={styles.statLabel}>HEAD</span>
						</div>
						<div className={styles.stat}>
							<span className={styles.statValue}>{relativeTime(worktree.lastActivityAt)}</span>
							<span className={styles.statLabel}>last change</span>
						</div>
						{base && (ahead > 0 || behind > 0) && (
							<div className={styles.stat}>
								<span className={styles.statValue}>↑{ahead} ↓{behind}</span>
								<span className={styles.statLabel}>vs {base}</span>
							</div>
						)}
						{base && behind > 0 && !worktree.isPrimary && (
							<Dropdown
								trigger={
									<button className={styles.updateBtn} disabled={updating}>
										{updating ? "Updating…" : `Update from ${base}`}
										<ChevronIcon size={12} />
									</button>
								}
							>
								<DropdownItem label={`Rebase onto ${base}`} onClick={() => update("rebase")} />
								<DropdownItem label={`Merge ${base}`} onClick={() => update("merge")} />
								<DropdownItem label={`Agent merge from ${base}`} onClick={agentMerge} />
							</Dropdown>
						)}
						{upstream && (
							<div className={styles.stat}>
								<span className={styles.statValue}>{upstream}</span>
								<span className={styles.statLabel}>tracking</span>
							</div>
						)}
						{upstream && (
							<div className={styles.stat}>
								<span className={styles.statValue}>
									{upstreamAhead === 0 && upstreamBehind === 0
										? "in sync"
										: `↑${upstreamAhead} ↓${upstreamBehind}`}
								</span>
								<span className={styles.statLabel}>vs tracking</span>
							</div>
						)}
						{canPush && (
							<button className={styles.updateBtn} onClick={push} disabled={pushing}>
								{pushing ? "Pushing…" : upstream ? `Push ↑${upstreamAhead}` : "Push"}
							</button>
						)}
						<div className={styles.badges}>
							{worktree.isPrimary && <span className={styles.primary}>primary</span>}
							{worktree.isDetached && <span className={styles.detached}>detached</span>}
							{worktree.isLocked && <span className={styles.locked}>locked</span>}
						</div>
						<button
							className={styles.refreshBtn}
							onClick={() => router.invalidate()}
							data-tip="Refresh changes"
							data-tip-align="end"
							aria-label="Refresh changes"
						>
							<RefreshIcon size={14} />
						</button>
					</section>

					{branch && (
						<BranchIntegrationBar
							projectId={projectId}
							worktreeId={worktree.id}
							branch={branch}
							base={base}
						/>
					)}

					{uncommitted.length > 0 && (
						<>
							<CommitBox
								total={uncommitted.length}
								stagedCount={stagedCount}
								message={message}
								onMessage={setMessage}
								onStageAll={() => stageAll(true)}
								onUnstageAll={() => stageAll(false)}
								onCommit={commit}
								committing={committing}
							/>
							<ChangeSection
								title="Uncommitted"
								files={uncommitted}
								base={null}
								worktreeId={worktree.id}
								projectId={projectId}
								staging={staging}
							/>
						</>
					)}

					<ChangeSection
						title="Changes"
						files={committed}
						base={base}
						worktreeId={worktree.id}
						projectId={projectId}
						bodyOverride={
							changesView === "commits" ? (
								<CommitsView
									worktreeId={worktree.id}
									projectId={projectId}
									base={base}
									head={worktree.head}
								/>
							) : undefined
						}
						emptyText={
							base
								? `No commits on this branch vs ${base}.`
								: "Pick a base branch to compare against."
						}
						right={
							<div className={styles.changesControls}>
								<div className={styles.segmented}>
									<button
										data-active={changesView === "files" || undefined}
										onClick={() => setChangesView("files")}
									>
										Files
									</button>
									<button
										data-active={changesView === "commits" || undefined}
										onClick={() => setChangesView("commits")}
									>
										Commits
									</button>
								</div>
								<label className={styles.baseSelect}>
									vs
									<BranchCombobox
										value={base}
										branches={branches.filter((b) => b !== branch)}
										onSelect={onSelectBase}
									/>
								</label>
							</div>
						}
					/>
				</div>
			</div>
			)}
		</div>
	);
}

function ChangeSection({
	title,
	files,
	base,
	worktreeId,
	projectId,
	right,
	emptyText,
	staging,
	bodyOverride,
}: {
	title: string;
	files: ChangedFile[];
	base: string | null;
	worktreeId: string;
	projectId: string;
	right?: ReactNode;
	emptyText?: string;
	staging?: Staging;
	/** Replaces the file tree + its filter/stat tools (e.g. the Commits view). */
	bodyOverride?: ReactNode;
}) {
	const [query, setQuery] = useState("");

	const ins = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
	const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);

	const q = query.trim().toLowerCase();
	const filtered = useMemo(
		() => (q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files),
		[files, q],
	);

	const showTools = files.length > 3;

	return (
		<Collapsible.Root defaultOpen className={styles.changeSection}>
			<div className={styles.sectionHead}>
				<div className={styles.changesTitle}>
					<Collapsible.Trigger className={styles.sectionToggle}>
						<ChevronIcon size={14} />
						<h2>{title}</h2>
					</Collapsible.Trigger>
					{right}
				</div>
				<div className={styles.sectionTools}>
					{!bodyOverride && showTools && (
						<input
							className={styles.filterInput}
							placeholder="Filter files…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							spellCheck={false}
						/>
					)}
					{!bodyOverride && files.length > 0 && (
						<span className={styles.diffStat}>
							{files.length} file{files.length === 1 ? "" : "s"}
							{ins > 0 && <span className={styles.add}> +{ins}</span>}
							{del > 0 && <span className={styles.del}> −{del}</span>}
						</span>
					)}
				</div>
			</div>
			<Collapsible.Panel className={styles.sectionPanel}>
				{bodyOverride ? (
					bodyOverride
				) : files.length === 0 ? (
					emptyText ? <p className={styles.empty}>{emptyText}</p> : null
				) : filtered.length === 0 ? (
					<p className={styles.empty}>No files match “{query}”.</p>
				) : (
					<FileTree
						files={filtered}
						showStats
						staging={staging}
						defaultExpanded
						forceOpen={q !== ""}
						onOpen={(f, o) => openDiff({ worktreeId, projectId, path: f.path, base, preview: o?.preview })}
					/>
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

// --- directory tree ---

type TreeFile = { type: "file"; file: ChangedFile };
type TreeDir = {
	type: "dir";
	name: string;
	path: string;
	children: TreeEntry[];
	count: number;
	ins: number;
	del: number;
};
type TreeEntry = TreeFile | TreeDir;

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/** Commits view: the branch's commits vs base, each expandable to its files.
 *  Re-fetches when `head` changes (a new commit landed) so it tracks agent work. */
function CommitsView({
	worktreeId,
	base,
	head,
	projectId,
}: {
	worktreeId: string;
	base: string | null;
	head: string | null;
	projectId: string;
}) {
	const [commits, setCommits] = useState<ListedCommit[] | null>(null);
	useEffect(() => {
		let live = true;
		if (!base) return setCommits([]);
		api.listCommits({ id: worktreeId, base }).then((c) => live && setCommits(c));
		return () => {
			live = false;
		};
		// head is a dep so a fresh commit re-fetches the list; base/worktree too.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [worktreeId, base, head]);

	if (!base) return <p className={styles.empty}>Pick a base branch to compare against.</p>;
	if (commits === null) return <p className={styles.empty}>Loading commits…</p>;
	if (commits.length === 0) return <p className={styles.empty}>No commits on this branch vs {base}.</p>;
	return (
		<div className={styles.commits}>
			{commits.map((c) => (
				<CommitRow key={c.hash} worktreeId={worktreeId} projectId={projectId} commit={c} />
			))}
		</div>
	);
}

function CommitRow({
	worktreeId,
	projectId,
	commit,
}: {
	worktreeId: string;
	projectId: string;
	commit: ListedCommit;
}) {
	const [open, setOpen] = useState(false);
	const [files, setFiles] = useState<ChangedFile[] | null>(null);

	useEffect(() => {
		if (open && files === null) {
			api.commitFiles({ id: worktreeId, hash: commit.hash }).then(setFiles);
		}
	}, [open, files, worktreeId, commit.hash]);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} className={styles.commitEntry}>
			<Collapsible.Trigger className={styles.commitEntryHead}>
				<ChevronIcon size={12} />
				<code className={styles.commitHash}>{commit.hash}</code>
				<span className={styles.commitSubject}>{commit.subject}</span>
				<span className={styles.commitMeta}>
					{commit.insertions > 0 && <span className={styles.add}>+{commit.insertions}</span>}
					{commit.deletions > 0 && <span className={styles.del}>−{commit.deletions}</span>}
					<span className={styles.commitTime}>{commit.relative}</span>
				</span>
			</Collapsible.Trigger>
			<Collapsible.Panel>
				{files === null ? (
					<p className={styles.empty}>Loading…</p>
				) : (
					<FileTree
						files={files}
						showStats
						defaultExpanded
						onOpen={(f, o) =>
							openDiff({ worktreeId, projectId, path: f.path, base: null, commit: commit.hash, preview: o?.preview })
						}
					/>
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

/** One visible row of the flattened file tree. */
type FlatNode = {
	path: string;
	name: string;
	depth: number;
	isDir: boolean;
	count?: number;
	ins?: number;
	del?: number;
	expanded?: boolean;
	file?: ChangedFile;
};

/** Flatten the tree to the rows currently visible (a folder's children only when
 *  it's expanded), in display order — the model the keyboard nav walks. */
function flattenTree(dir: TreeDir, isOpen: (path: string) => boolean, depth = 0): FlatNode[] {
	const out: FlatNode[] = [];
	for (const child of dir.children) {
		if (child.type === "dir") {
			const open = isOpen(child.path);
			out.push({
				path: child.path,
				name: child.name,
				depth,
				isDir: true,
				count: child.count,
				ins: child.ins,
				del: child.del,
				expanded: open,
			});
			if (open) out.push(...flattenTree(child, isOpen, depth + 1));
		} else {
			out.push({ path: child.file.path, name: basename(child.file.path), depth, isDir: false, file: child.file });
		}
	}
	return out;
}

/**
 * The shared file tree: a keyboard-navigable ARIA tree (↑/↓ move, →/← expand or
 * step, Enter/Space activate a file or toggle a folder, "s" stages when staging is
 * enabled, Home/End jump). `showStats` adds the change kind + ±line counts; `onOpen`
 * is what activating a file does (open a diff, or a file in the editor).
 */
function FileTree({
	files,
	onOpen,
	showStats,
	staging,
	forceOpen,
	defaultExpanded,
}: {
	files: ChangedFile[];
	/** Activate a file: single click/Enter previews; double-click opens permanent. */
	onOpen: (file: ChangedFile, opts?: { preview?: boolean }) => void;
	showStats?: boolean;
	staging?: Staging;
	forceOpen?: boolean;
	/** Start with all folders open (they can still be collapsed individually). */
	defaultExpanded?: boolean;
}) {
	// `overrides` holds folders toggled *away* from the default: when defaultExpanded
	// it's the collapsed ones, otherwise the expanded ones. So new folders follow the
	// default and manual toggles are remembered across data refreshes.
	const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
	const [focusIdx, setFocusIdx] = useState(0);
	const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

	const isOpen = useCallback(
		(path: string) => forceOpen || (defaultExpanded ? !overrides.has(path) : overrides.has(path)),
		[forceOpen, defaultExpanded, overrides],
	);
	const tree = useMemo(() => buildTree(files), [files]);
	const flat = useMemo(() => flattenTree(tree, isOpen), [tree, isOpen]);

	useEffect(() => {
		if (focusIdx > flat.length - 1) setFocusIdx(Math.max(0, flat.length - 1));
	}, [flat.length, focusIdx]);

	function focusRow(i: number) {
		const n = Math.max(0, Math.min(i, flat.length - 1));
		setFocusIdx(n);
		itemRefs.current[n]?.focus();
	}
	function toggle(path: string, open?: boolean) {
		const want = open ?? !isOpen(path);
		setOverrides((prev) => {
			const s = new Set(prev);
			// membership means collapsed (defaultExpanded) or expanded (otherwise)
			const member = defaultExpanded ? !want : want;
			if (member) s.add(path);
			else s.delete(path);
			return s;
		});
	}
	function stageNode(node: FlatNode) {
		if (!staging) return;
		if (node.file) {
			staging.onToggle(node.file.path);
		} else {
			const under = files.filter((f) => f.path === node.path || f.path.startsWith(node.path + "/"));
			const allStaged = under.length > 0 && under.every((f) => staging.isStaged(f.path));
			staging.onSetMany(under.map((f) => f.path), !allStaged);
		}
	}
	function activate(node: FlatNode) {
		if (node.isDir) toggle(node.path);
		else if (node.file) onOpen(node.file);
	}
	function onKeyDown(e: React.KeyboardEvent) {
		const node = flat[focusIdx];
		if (!node) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				focusRow(focusIdx + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				focusRow(focusIdx - 1);
				break;
			case "Home":
				e.preventDefault();
				focusRow(0);
				break;
			case "End":
				e.preventDefault();
				focusRow(flat.length - 1);
				break;
			case "ArrowRight":
				e.preventDefault();
				if (node.isDir && !node.expanded) toggle(node.path, true);
				else if (node.isDir) focusRow(focusIdx + 1);
				break;
			case "ArrowLeft":
				e.preventDefault();
				if (node.isDir && node.expanded) {
					toggle(node.path, false);
				} else {
					for (let i = focusIdx - 1; i >= 0; i--) {
						if (flat[i].depth < node.depth) {
							focusRow(i);
							break;
						}
					}
				}
				break;
			case "s":
			case "S":
				if (staging) {
					e.preventDefault();
					stageNode(node);
				}
				break;
			case "Enter":
			case " ":
				e.preventDefault();
				activate(node);
				break;
		}
	}

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
		<div className={styles.files} role="tree" onKeyDown={onKeyDown}>
			{flat.map((n, i) => {
				const under =
					staging && n.isDir
						? files.filter((f) => f.path === n.path || f.path.startsWith(n.path + "/"))
						: null;
				const stagedN = under ? under.reduce((c, f) => c + (staging!.isStaged(f.path) ? 1 : 0), 0) : 0;
				const allStaged = under ? under.length > 0 && stagedN === under.length : false;
				return (
					<div
						key={n.path}
						ref={(el) => {
							itemRefs.current[i] = el;
						}}
						role="treeitem"
						aria-level={n.depth + 1}
						aria-expanded={n.isDir ? !!n.expanded : undefined}
						tabIndex={i === focusIdx ? 0 : -1}
						className={styles.treeRow}
						data-kind={n.file?.kind}
						style={{ paddingLeft: 10 + n.depth * 14 }}
						onClick={() => {
							setFocusIdx(i);
							activate(n);
						}}
						onDoubleClick={() => {
							if (n.file) onOpen(n.file, { preview: false }); // double-click → keep open
						}}
						title={n.path}
					>
						{staging && (
							<input
								type="checkbox"
								className={styles.stageCheck}
								checked={n.file ? staging.isStaged(n.file.path) : allStaged}
								ref={(el) => {
									if (el) el.indeterminate = !n.file && stagedN > 0 && !allStaged;
								}}
								onClick={(e) => e.stopPropagation()}
								onChange={() => stageNode(n)}
								tabIndex={-1}
								title={n.isDir ? "Stage folder" : "Stage file"}
							/>
						)}
						{n.isDir ? (
							<span className={styles.treeChevron} data-open={n.expanded || undefined}>
								<ChevronIcon size={12} />
							</span>
						) : (
							<span className={styles.treeChevronSpacer} />
						)}
						{n.isDir ? (
							<FolderIcon size={13} />
						) : showStats && n.file ? (
							<span className={styles.kind} title={n.file.kind}>
								{KIND_LABEL[n.file.kind]}
							</span>
						) : (
							<FileIcon size={13} />
						)}
						<span className={styles.treeName}>{n.name}</span>
						<span className={styles.treeMeta}>
							{n.isDir && <span className={styles.dirMeta}>{n.count}</span>}
							{showStats && (n.ins ?? 0) > 0 && <span className={styles.add}>+{n.ins}</span>}
							{showStats && (n.del ?? 0) > 0 && <span className={styles.del}>−{n.del}</span>}
						</span>
					</div>
				);
			})}
		</div>
	);
}

/** Whole-repo file browser (all tracked + untracked files). Clicking/activating a
 *  file opens it in a Monaco editor tab. */
function FileBrowser({ worktreeId, projectId }: { worktreeId: string; projectId: string }) {
	const [paths, setPaths] = useState<string[] | null>(null);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let live = true;
		api.listFiles({ id: worktreeId }).then((p) => live && setPaths(p));
		return () => {
			live = false;
		};
	}, [worktreeId]);

	const q = query.trim().toLowerCase();
	const files = useMemo(
		() =>
			(paths ?? [])
				.filter((p) => !q || p.toLowerCase().includes(q))
				.map((p) => ({
					path: p,
					kind: "modified" as ChangeKind,
					insertions: null,
					deletions: null,
					staged: false,
				})),
		[paths, q],
	);

	return (
		<div className={styles.browser}>
			<div className={styles.browserTools}>
				<input
					className={styles.filterInput}
					placeholder="Filter files…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					spellCheck={false}
				/>
			</div>
			<div className={styles.browserScroll}>
				{paths === null ? (
					<p className={styles.empty}>Loading…</p>
				) : files.length === 0 ? (
					<p className={styles.empty}>{q ? `No files match “${query}”.` : "No files."}</p>
				) : (
					<FileTree
						files={files}
						forceOpen={q !== ""}
						onOpen={(f, o) => openFile({ worktreeId, projectId, path: f.path, preview: o?.preview })}
					/>
				)}
			</div>
		</div>
	);
}

function buildTree(files: ChangedFile[]): TreeDir {
	const root: TreeDir = { type: "dir", name: "", path: "", children: [], count: 0, ins: 0, del: 0 };
	for (const file of files) {
		const segs = file.path.split("/");
		segs.pop();
		let node = root;
		let acc = "";
		for (const seg of segs) {
			acc = acc ? `${acc}/${seg}` : seg;
			let next = node.children.find((c): c is TreeDir => c.type === "dir" && c.name === seg);
			if (!next) {
				next = { type: "dir", name: seg, path: acc, children: [], count: 0, ins: 0, del: 0 };
				node.children.push(next);
			}
			node = next;
		}
		node.children.push({ type: "file", file });
	}
	root.children = root.children.map(collapseDir);
	sortDir(root);
	aggregate(root);
	return root;
}

function collapseDir(entry: TreeEntry): TreeEntry {
	if (entry.type !== "dir") return entry;
	entry.children = entry.children.map(collapseDir);
	while (entry.children.length === 1 && entry.children[0].type === "dir") {
		const only: TreeDir = entry.children[0];
		entry = { ...entry, name: `${entry.name}/${only.name}`, path: only.path, children: only.children };
	}
	return entry;
}

function sortDir(dir: TreeDir): void {
	dir.children.sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		const an = a.type === "dir" ? a.name : basename(a.file.path);
		const bn = b.type === "dir" ? b.name : basename(b.file.path);
		return an.localeCompare(bn);
	});
	for (const c of dir.children) if (c.type === "dir") sortDir(c);
}

function aggregate(entry: TreeEntry): { count: number; ins: number; del: number } {
	if (entry.type === "file") {
		return { count: 1, ins: entry.file.insertions ?? 0, del: entry.file.deletions ?? 0 };
	}
	let count = 0;
	let ins = 0;
	let del = 0;
	for (const c of entry.children) {
		const a = aggregate(c);
		count += a.count;
		ins += a.ins;
		del += a.del;
	}
	entry.count = count;
	entry.ins = ins;
	entry.del = del;
	return { count, ins, del };
}

function CommitBox({
	total,
	stagedCount,
	message,
	onMessage,
	onStageAll,
	onUnstageAll,
	onCommit,
	committing,
}: {
	total: number;
	stagedCount: number;
	message: string;
	onMessage: (m: string) => void;
	onStageAll: () => void;
	onUnstageAll: () => void;
	onCommit: () => void;
	committing: boolean;
}) {
	const canCommit = stagedCount > 0 && message.trim() !== "" && !committing;
	return (
		<div className={styles.commitBox}>
			<div className={styles.commitHead}>
				<span className={styles.commitCount}>
					{stagedCount} of {total} staged
				</span>
				<button
					className={styles.toolButton}
					onClick={stagedCount < total ? onStageAll : onUnstageAll}
				>
					{stagedCount < total ? "Stage all" : "Unstage all"}
				</button>
			</div>
			<textarea
				className={styles.commitMsg}
				placeholder="Commit message…  (⌘↵ to commit)"
				value={message}
				onChange={(e) => onMessage(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onCommit();
				}}
				rows={2}
				spellCheck={false}
			/>
			<button className={styles.commitBtn} onClick={onCommit} disabled={!canCommit}>
				{committing ? "Committing…" : `Commit${stagedCount ? ` ${stagedCount}` : ""}`}
			</button>
		</div>
	);
}

