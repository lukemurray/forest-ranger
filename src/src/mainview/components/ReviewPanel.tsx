import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import {
	Diff as DiffViewer,
	Hunk,
	markEdits,
	parseDiff,
	tokenize,
	type HunkData,
} from "react-diff-view";
import { refractor } from "refractor";
import "react-diff-view/style/index.css";
import type {
	ChangedFile,
	ChangeKind,
	FileDiff,
	WorktreeDetail,
} from "../../shared/types";
import { BranchCombobox } from "./BranchCombobox";
import { Dropdown, DropdownItem } from "./Dropdown";
import { BranchIntegrationBar } from "./BranchIntegrationBar";
import { ChevronIcon, FolderIcon } from "./icons";
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

	// Drop optimistic overrides once fresh data (with real staged flags) arrives.
	const stagedSig = uncommitted.map((f) => `${f.path}:${f.staged ? 1 : 0}`).join("|");
	useEffect(() => {
		setOptimistic(new Map());
	}, [stagedSig]);

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
								staging={staging}
							/>
						</>
					)}

					<ChangeSection
						title="Changes"
						files={committed}
						base={base}
						worktreeId={worktree.id}
						emptyText={
							base
								? `No commits on this branch vs ${base}.`
								: "Pick a base branch to compare against."
						}
						right={
							<label className={styles.baseSelect}>
								vs
								<BranchCombobox
									value={base}
									branches={branches.filter((b) => b !== branch)}
									onSelect={onSelectBase}
								/>
							</label>
						}
					/>
				</div>
			</div>
		</div>
	);
}

function ChangeSection({
	title,
	files,
	base,
	worktreeId,
	right,
	emptyText,
	staging,
}: {
	title: string;
	files: ChangedFile[];
	base: string | null;
	worktreeId: string;
	right?: ReactNode;
	emptyText?: string;
	staging?: Staging;
}) {
	const [query, setQuery] = useState("");
	const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());

	const ins = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
	const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);

	const q = query.trim().toLowerCase();
	const filtered = useMemo(
		() => (q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files),
		[files, q],
	);
	const tree = useMemo(() => buildTree(filtered), [filtered]);

	const setFileOpen = useCallback((path: string, next: boolean) => {
		setOpenFiles((prev) => {
			const n = new Set(prev);
			if (next) n.add(path);
			else n.delete(path);
			return n;
		});
	}, []);

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
					{showTools && (
						<input
							className={styles.filterInput}
							placeholder="Filter files…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							spellCheck={false}
						/>
					)}
					{openFiles.size > 0 && (
						<button className={styles.toolButton} onClick={() => setOpenFiles(new Set())}>
							Collapse all
						</button>
					)}
					{files.length > 0 && (
						<span className={styles.diffStat}>
							{files.length} file{files.length === 1 ? "" : "s"}
							{ins > 0 && <span className={styles.add}> +{ins}</span>}
							{del > 0 && <span className={styles.del}> −{del}</span>}
						</span>
					)}
				</div>
			</div>
			<Collapsible.Panel className={styles.sectionPanel}>
				{files.length === 0 ? (
					emptyText ? <p className={styles.empty}>{emptyText}</p> : null
				) : filtered.length === 0 ? (
					<p className={styles.empty}>No files match “{query}”.</p>
				) : (
					<div className={styles.files}>
						{tree.children.map((c) =>
							c.type === "dir" ? (
								<FolderNode
									key={c.path}
									node={c}
									depth={0}
									base={base}
									worktreeId={worktreeId}
									openFiles={openFiles}
									setFileOpen={setFileOpen}
									forceOpen={q !== ""}
									staging={staging}
								/>
							) : (
								<FileRow
									key={c.file.path}
									file={c.file}
									depth={0}
									base={base}
									worktreeId={worktreeId}
									open={openFiles.has(c.file.path)}
									onOpenChange={(o) => setFileOpen(c.file.path, o)}
									staging={staging}
								/>
							),
						)}
					</div>
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

/** All file paths under a tree node, depth-first. */
function filePaths(node: TreeDir): string[] {
	const out: string[] = [];
	for (const c of node.children) {
		if (c.type === "dir") out.push(...filePaths(c));
		else out.push(c.file.path);
	}
	return out;
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

function FolderNode({
	node,
	depth,
	base,
	worktreeId,
	openFiles,
	setFileOpen,
	forceOpen,
	staging,
}: {
	node: TreeDir;
	depth: number;
	base: string | null;
	worktreeId: string;
	openFiles: Set<string>;
	setFileOpen: (path: string, next: boolean) => void;
	forceOpen: boolean;
	staging?: Staging;
}) {
	const [open, setOpen] = useState(true);
	const isOpen = forceOpen || open;

	const paths = useMemo(() => filePaths(node), [node]);
	const stagedN = staging ? paths.reduce((n, p) => n + (staging.isStaged(p) ? 1 : 0), 0) : 0;
	const allStaged = staging != null && paths.length > 0 && stagedN === paths.length;
	const someStaged = stagedN > 0 && !allStaged;
	const checkRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (checkRef.current) checkRef.current.indeterminate = someStaged;
	}, [someStaged]);

	return (
		<Collapsible.Root open={isOpen} onOpenChange={setOpen} className={styles.treeDir}>
			<div className={styles.dirRowOuter} style={{ paddingLeft: 12 + depth * 14 }}>
				{staging && (
					<input
						ref={checkRef}
						type="checkbox"
						className={styles.stageCheck}
						checked={allStaged}
						onChange={() => staging.onSetMany(paths, !allStaged)}
						title={allStaged ? "Staged — click to unstage folder" : "Click to stage folder"}
					/>
				)}
				<Collapsible.Trigger className={styles.dirRow}>
					<ChevronIcon size={12} />
					<FolderIcon size={13} />
					<span className={styles.dirName}>{node.name}</span>
					<span className={styles.dirMeta}>
						{node.count}
						{node.ins > 0 && <span className={styles.add}> +{node.ins}</span>}
						{node.del > 0 && <span className={styles.del}> −{node.del}</span>}
					</span>
				</Collapsible.Trigger>
			</div>
			<Collapsible.Panel>
				{node.children.map((c) =>
					c.type === "dir" ? (
						<FolderNode
							key={c.path}
							node={c}
							depth={depth + 1}
							base={base}
							worktreeId={worktreeId}
							openFiles={openFiles}
							setFileOpen={setFileOpen}
							forceOpen={forceOpen}
							staging={staging}
						/>
					) : (
						<FileRow
							key={c.file.path}
							file={c.file}
							depth={depth + 1}
							base={base}
							worktreeId={worktreeId}
							open={openFiles.has(c.file.path)}
							onOpenChange={(o) => setFileOpen(c.file.path, o)}
							staging={staging}
						/>
					),
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

function FileRow({
	worktreeId,
	file,
	base,
	depth,
	open,
	onOpenChange,
	staging,
}: {
	worktreeId: string;
	file: ChangedFile;
	base: string | null;
	depth: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	staging?: Staging;
}) {
	const [diff, setDiff] = useState<FileDiff | null>(null);
	const fetching = useRef(false);
	const name = basename(file.path);
	const staged = staging?.isStaged(file.path) ?? false;

	useEffect(() => {
		if (open && diff === null && !fetching.current) {
			fetching.current = true;
			api
				.fileDiff({ id: worktreeId, path: file.path, base })
				.then(setDiff)
				.finally(() => {
					fetching.current = false;
				});
		}
	}, [open, diff, worktreeId, file.path, base]);

	return (
		<Collapsible.Root
			open={open}
			onOpenChange={onOpenChange}
			className={styles.file}
			data-kind={file.kind}
		>
			<div className={styles.fileRowOuter} style={{ paddingLeft: 12 + depth * 14 }}>
				{staging && (
					<input
						type="checkbox"
						className={styles.stageCheck}
						checked={staged}
						onChange={() => staging.onToggle(file.path)}
						title={staged ? "Staged — click to unstage" : "Click to stage"}
					/>
				)}
				<Collapsible.Trigger className={styles.fileRow}>
					<ChevronIcon size={13} />
					<span className={styles.kind} title={file.kind}>
						{KIND_LABEL[file.kind]}
					</span>
					<span className={styles.path} title={file.path}>
						{name}
					</span>
					<span className={styles.lines}>
						{file.insertions != null && file.insertions > 0 && (
							<span className={styles.add}>+{file.insertions}</span>
						)}
						{file.deletions != null && file.deletions > 0 && (
							<span className={styles.del}>−{file.deletions}</span>
						)}
					</span>
				</Collapsible.Trigger>
			</div>

			<Collapsible.Panel className={styles.diffPanel}>
				{diff === null ? (
					<div className={styles.diffNote}>Loading diff…</div>
				) : diff.binary ? (
					<div className={styles.diffNote}>Binary file — no text diff.</div>
				) : diff.diff.trim() === "" ? (
					<div className={styles.diffNote}>No diff available.</div>
				) : (
					<Diff diffText={diff.diff} path={diff.path} />
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
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

const LANG_BY_EXT: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
	mjs: "javascript", cjs: "javascript", json: "json", css: "css",
	scss: "scss", less: "less", html: "markup", xml: "markup", vue: "markup",
	svelte: "markup", md: "markdown", mdx: "markdown", py: "python", rb: "ruby",
	go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c",
	cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", swift: "swift",
	sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml",
	toml: "toml", sql: "sql", graphql: "graphql", gql: "graphql",
};

function langForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	const lang = ext ? LANG_BY_EXT[ext] : undefined;
	return lang && refractor.registered(lang) ? lang : undefined;
}

function Diff({ diffText, path }: { diffText: string; path: string }) {
	const files = parseDiff(diffText);
	const file = files[0];
	if (!file || file.hunks.length === 0) {
		return <div className={styles.diffNote}>No diff available.</div>;
	}

	const lang = langForPath(path);
	let tokens;
	try {
		tokens = tokenize(file.hunks as HunkData[], {
			highlight: !!lang,
			refractor,
			language: lang as string,
			enhancers: [markEdits(file.hunks as HunkData[], { type: "block" })],
		});
	} catch {
		tokens = undefined;
	}

	return (
		<div className={styles.diff}>
			<DiffViewer viewType="unified" diffType={file.type} hunks={file.hunks} tokens={tokens}>
				{(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
			</DiffViewer>
		</div>
	);
}
