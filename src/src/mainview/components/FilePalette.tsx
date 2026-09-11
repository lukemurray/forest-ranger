import { useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { api } from "../rpc";
import { openDiff, openFile } from "../lib/terminalStore";
import { Modal } from "./ui/Modal";
import { FileIcon } from "./icons";
import styles from "./CommandPalette.module.css";

type Item = { kind: "file"; path: string } | { kind: "diff"; path: string; base: string | null };

function basename(p: string): string {
	return p.split("/").pop() ?? p;
}

/**
 * ⌘P quick-open for the current worktree: type to find any file. Files that have
 * uncommitted changes also list a "diff" entry, so you can jump straight to the
 * diff. Opens the file in a Monaco editor tab, or the diff in a diff tab.
 */
export function FilePalette() {
	const params = useParams({ strict: false });
	const worktreeId = params.worktreeId;
	const projectId = params.projectId;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<Item[]>([]);
	const [sel, setSel] = useState(0);

	// ⌘P / Ctrl+P — only meaningful inside a worktree.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
				if (!worktreeId) return;
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [worktreeId]);

	// Close when navigating to a different worktree.
	useEffect(() => setOpen(false), [worktreeId]);

	useEffect(() => {
		if (!open || !worktreeId) return;
		setQuery("");
		setSel(0);
		Promise.all([
			api.listFiles({ id: worktreeId }),
			api.worktreeDetail({ id: worktreeId, base: null }),
		]).then(([files, detail]) => {
			// A file's diff opens against the working tree if it has uncommitted edits,
			// else against the base (the branch's committed diff). uncommitted wins.
			const diffBase = new Map<string, string | null>();
			for (const f of detail?.committed ?? []) diffBase.set(f.path, detail?.base ?? null);
			for (const f of detail?.uncommitted ?? []) diffBase.set(f.path, null);

			const list: Item[] = [];
			for (const p of files) {
				list.push({ kind: "file", path: p });
				if (diffBase.has(p)) list.push({ kind: "diff", path: p, base: diffBase.get(p) ?? null });
			}
			// Changed files not in listFiles (e.g. deleted) still deserve a diff entry.
			for (const [p, base] of diffBase) if (!files.includes(p)) list.push({ kind: "diff", path: p, base });
			setItems(list);
		});
	}, [open, worktreeId]);

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items.slice(0, 60);
		const scored = items
			.map((it) => {
				const i = it.path.toLowerCase().indexOf(q);
				if (i === -1) return null;
				// Prefer matches in the filename over the directory portion.
				const rank = basename(it.path).toLowerCase().includes(q) ? 0 : 1;
				return { it, rank, i };
			})
			.filter((x): x is { it: Item; rank: number; i: number } => x !== null)
			.sort((a, b) => a.rank - b.rank || a.i - b.i);
		return scored.slice(0, 60).map((x) => x.it);
	}, [items, query]);

	function activate(it: Item | undefined) {
		if (!it || !worktreeId || !projectId) return;
		setOpen(false);
		if (it.kind === "file") openFile({ worktreeId, projectId, path: it.path });
		else openDiff({ worktreeId, projectId, path: it.path, base: it.base });
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSel((s) => Math.min(s + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSel((s) => Math.max(s - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			activate(results[sel]);
		}
	}

	const selClamped = Math.min(sel, Math.max(results.length - 1, 0));

	return (
		<Modal open={open} onOpenChange={setOpen} width={560}>
			<input
				className={styles.input}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setSel(0);
				}}
				onKeyDown={onKeyDown}
				placeholder="Find a file in this worktree…"
				autoFocus
				spellCheck={false}
			/>
			<div className={styles.results}>
				{results.length === 0 ? (
					<div className={styles.empty}>No matches</div>
				) : (
					results.map((it, i) => (
						<button
							key={`${it.kind}:${it.path}`}
							className={styles.row}
							data-selected={i === selClamped || undefined}
							onMouseEnter={() => setSel(i)}
							onClick={() => activate(it)}
						>
							<FileIcon size={14} />
							<span className={styles.rowLabel}>{basename(it.path)}</span>
							<span className={styles.rowSub}>{it.path}</span>
							{it.kind === "diff" && <span className={styles.rowTag}>diff</span>}
						</button>
					))
				)}
			</div>
		</Modal>
	);
}
