import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Collapsible } from "@base-ui-components/react/collapsible";
import { Combobox } from "@base-ui-components/react/combobox";
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
	ProjectCommand,
} from "../../shared/types";
import { worktreeRoute } from "../router";
import { Titlebar } from "../components/Titlebar";
import { CommandDialog } from "../components/CommandDialog";
import { MenuItem, RowMenu, Separator } from "../components/RowMenu";
import {
	ChevronIcon,
	ChevronUpDownIcon,
	FolderIcon,
	GitBranchIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	RevealIcon,
	TerminalIcon,
	TrashIcon,
} from "../components/icons";
import { api } from "../rpc";
import { openInEditor, openInTerminal, runProjectCommand } from "../lib/openTargets";
import { openSession } from "../lib/terminalStore";
import { relativeTime, shortHash, splitPath } from "../lib/format";
import tb from "../components/Titlebar.module.css";
import styles from "./WorktreeView.module.css";

const KIND_LABEL: Record<ChangeKind, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "U",
	typechange: "T",
	conflicted: "C",
};

export function WorktreeView() {
	const detail = worktreeRoute.useLoaderData();
	const { projectId } = worktreeRoute.useParams();
	const navigate = useNavigate();
	const router = useRouter();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<ProjectCommand | null>(null);

	function openAdd() {
		setEditing(null);
		setDialogOpen(true);
	}
	function openEdit(cmd: ProjectCommand) {
		setEditing(cmd);
		setDialogOpen(true);
	}
	async function submitCommand(
		label: string,
		command: string,
		dir: string,
		runTarget: "in-app" | "external",
	) {
		if (editing) {
			await api.updateCommand({ id: editing.id, label, command, dir, runTarget });
		} else {
			await api.addCommand({ projectId, label, command, dir, runTarget });
		}
		router.invalidate();
	}
	async function removeCommand(id: string) {
		await api.removeCommand({ id });
		router.invalidate();
	}

	if (!detail) {
		return (
			<div className={styles.view}>
				<Titlebar>Worktree unavailable</Titlebar>
				<div className={styles.scroll}>
					<div className={styles.body}>
						<p className={styles.empty}>This worktree no longer exists.</p>
					</div>
				</div>
			</div>
		);
	}

	const { worktree, projectName, branch, base, branches, ahead, behind, committed, uncommitted, commands } =
		detail;

	function selectBase(next: string) {
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId: worktree.id },
			search: { base: next || undefined },
		});
	}

	function run(cmd: ProjectCommand) {
		if (cmd.runTarget === "external") {
			runProjectCommand(cmd.id, worktree.path);
		} else {
			openSession({
				worktreeId: worktree.id,
				projectId,
				commandId: cmd.id,
				title: `${branch ?? "detached"} · ${cmd.label}`,
			});
		}
	}

	return (
		<div className={styles.view}>
			<Titlebar
				title={worktree.path}
				actions={
					<>
						<button
							className={tb.actionButton}
							onClick={() => openInEditor(worktree.path)}
						>
							<FolderIcon /> Editor
						</button>
						<button
							className={tb.actionButton}
							onClick={() => openInTerminal(worktree.path)}
						>
							<TerminalIcon /> Terminal
						</button>
						<button
							className={tb.actionButton}
							onClick={() => api.revealInFinder({ path: worktree.path })}
							title="Reveal in Finder"
						>
							<RevealIcon />
						</button>
					</>
				}
			>
				<button
					className={styles.crumb}
					onClick={() =>
						navigate({ to: "/project/$projectId", params: { projectId } })
					}
				>
					{projectName}
				</button>
				<span className={tb.muted}>/</span>
				<GitBranchIcon size={15} />
				{branch ?? "detached"}
			</Titlebar>

			<div className={styles.scroll}>
				<div className={styles.body}>
					<section className={styles.commands}>
						{commands.map((cmd) => (
							<RowMenu
								key={cmd.id}
								trigger={
									<button
										className={styles.runButton}
										onClick={() => run(cmd)}
										title={cmd.command}
									>
										<PlayIcon size={13} /> {cmd.label}
									</button>
								}
							>
								<MenuItem
									icon={<PencilIcon size={15} />}
									label="Edit command"
									onClick={() => openEdit(cmd)}
								/>
								<Separator />
								<MenuItem
									icon={<TrashIcon size={15} />}
									label="Delete command"
									danger
									onClick={() => removeCommand(cmd.id)}
								/>
							</RowMenu>
						))}
						<button className={styles.addCommandButton} onClick={openAdd}>
							<PlusIcon size={14} /> {commands.length === 0 ? "Add a run command" : "Add"}
						</button>
					</section>

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
						<div className={styles.badges}>
							{worktree.isPrimary && <span className={styles.primary}>primary</span>}
							{worktree.isDetached && <span className={styles.detached}>detached</span>}
							{worktree.isLocked && <span className={styles.locked}>locked</span>}
						</div>
					</section>

					{uncommitted.length > 0 && (
						<ChangeSection
							title="Uncommitted"
							files={uncommitted}
							base={null}
							worktreeId={worktree.id}
						/>
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
									onSelect={selectBase}
								/>
							</label>
						}
					/>
				</div>
			</div>

			<CommandDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				title={editing ? "Edit command" : "Add command"}
				initialLabel={editing?.label ?? ""}
				initialCommand={editing?.command ?? ""}
				initialDir={editing?.dir ?? ""}
				initialRunTarget={editing?.runTarget ?? "in-app"}
				onSubmit={submitCommand}
			/>
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
}: {
	title: string;
	files: ChangedFile[];
	base: string | null;
	worktreeId: string;
	right?: ReactNode;
	emptyText?: string;
}) {
	const ins = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
	const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);

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
				{files.length > 0 && (
					<span className={styles.diffStat}>
						{files.length} file{files.length === 1 ? "" : "s"}
						{ins > 0 && <span className={styles.add}> +{ins}</span>}
						{del > 0 && <span className={styles.del}> −{del}</span>}
					</span>
				)}
			</div>
			<Collapsible.Panel className={styles.sectionPanel}>
				{files.length === 0 ? (
					emptyText ? <p className={styles.empty}>{emptyText}</p> : null
				) : (
					<div className={styles.files}>
						{files.map((f) => (
							<FileRow key={f.path} worktreeId={worktreeId} file={f} base={base} />
						))}
					</div>
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

function BranchCombobox({
	value,
	branches,
	onSelect,
}: {
	value: string | null;
	branches: string[];
	onSelect: (branch: string) => void;
}) {
	return (
		<Combobox.Root
			items={branches}
			value={value ?? ""}
			onValueChange={(v) => {
				if (typeof v === "string" && v) onSelect(v);
			}}
		>
			<div className={styles.combo}>
				<Combobox.Input
					className={styles.comboInput}
					placeholder="branch…"
					// Defer so the selection wins over the component's own focus handling,
					// letting you type to replace the current branch right away.
					onFocus={(e) => {
						const el = e.currentTarget;
						setTimeout(() => el.select(), 0);
					}}
				/>
				<Combobox.Icon className={styles.comboIcon}>
					<ChevronUpDownIcon size={13} />
				</Combobox.Icon>
			</div>
			<Combobox.Portal>
				<Combobox.Positioner className={styles.comboPositioner} sideOffset={4}>
					<Combobox.Popup className={styles.comboPopup}>
						<Combobox.Empty className={styles.comboEmpty}>
							No matching branch
						</Combobox.Empty>
						<Combobox.List>
							{(item: string) => (
								<Combobox.Item key={item} value={item} className={styles.comboItem}>
									{item}
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

function FileRow({
	worktreeId,
	file,
	base,
}: {
	worktreeId: string;
	file: ChangedFile;
	base: string | null;
}) {
	const [open, setOpen] = useState(false);
	const [diff, setDiff] = useState<FileDiff | null>(null);
	const fetching = useRef(false);
	const { dir, name } = splitPath(file.path);

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
			onOpenChange={setOpen}
			className={styles.file}
			data-kind={file.kind}
		>
			<Collapsible.Trigger className={styles.fileRow}>
				<ChevronIcon size={13} />
				<span className={styles.kind} title={file.kind}>
					{KIND_LABEL[file.kind]}
				</span>
				<span className={styles.path}>
					{dir && <span className={styles.dir}>{dir}</span>}
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
		tokens = undefined; // highlighting failed — fall back to plain diff
	}

	return (
		<div className={styles.diff}>
			<DiffViewer viewType="unified" diffType={file.type} hunks={file.hunks} tokens={tokens}>
				{(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
			</DiffViewer>
		</div>
	);
}
