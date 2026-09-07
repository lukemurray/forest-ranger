import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../rpc";
import { Modal } from "./ui/Modal";
import { FolderIcon, GitBranchIcon } from "./icons";
import styles from "./CommandPalette.module.css";

type Item =
	| { kind: "worktree"; id: string; projectId: string; label: string; sub: string }
	| { kind: "project"; id: string; label: string; sub: string };

/** ⌘K fuzzy jump to any project or worktree. */
export function CommandPalette() {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [items, setItems] = useState<Item[]>([]);
	const [sel, setSel] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// Global ⌘K / Ctrl+K toggle.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Load the index each time it opens (cheap, and stays fresh).
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setSel(0);
		Promise.all([api.listProjects({}), api.recentWorktrees({ limit: 200 })]).then(
			([projects, worktrees]) => {
				setItems([
					...worktrees.map(
						(w): Item => ({
							kind: "worktree",
							id: w.id,
							projectId: w.projectId,
							label: w.branch ?? "detached",
							sub: w.projectName,
						}),
					),
					...projects.map((p): Item => ({ kind: "project", id: p.id, label: p.name, sub: "project" })),
				]);
			},
		);
	}, [open]);

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items.slice(0, 50);
		const scored = items
			.map((it) => {
				const hay = `${it.label} ${it.sub}`.toLowerCase();
				const i = hay.indexOf(q);
				if (i === -1) return null;
				// Rank: label-prefix match beats mid-string beats sub-only match.
				const rank = it.label.toLowerCase().startsWith(q) ? 0 : it.label.toLowerCase().includes(q) ? 1 : 2;
				return { it, rank, i };
			})
			.filter((x): x is { it: Item; rank: number; i: number } => x !== null)
			.sort((a, b) => a.rank - b.rank || a.i - b.i);
		return scored.slice(0, 50).map((x) => x.it);
	}, [items, query]);

	function activate(it: Item | undefined) {
		if (!it) return;
		setOpen(false);
		if (it.kind === "project") {
			navigate({ to: "/project/$projectId", params: { projectId: it.id } });
		} else {
			navigate({
				to: "/project/$projectId/worktree/$worktreeId",
				params: { projectId: it.projectId, worktreeId: it.id },
			});
		}
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

	// Keep selection in range as results shrink.
	const selClamped = Math.min(sel, Math.max(results.length - 1, 0));

	return (
		<Modal open={open} onOpenChange={setOpen} width={560}>
			<input
				ref={inputRef}
				className={styles.input}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setSel(0);
				}}
				onKeyDown={onKeyDown}
				placeholder="Jump to a worktree or project…"
				autoFocus
				spellCheck={false}
			/>
			<div className={styles.results}>
				{results.length === 0 ? (
					<div className={styles.empty}>No matches</div>
				) : (
					results.map((it, i) => (
						<button
							key={`${it.kind}:${it.id}`}
							className={styles.row}
							data-selected={i === selClamped || undefined}
							onMouseEnter={() => setSel(i)}
							onClick={() => activate(it)}
						>
							{it.kind === "worktree" ? <GitBranchIcon size={14} /> : <FolderIcon size={14} />}
							<span className={styles.rowLabel}>{it.label}</span>
							<span className={styles.rowSub}>{it.sub}</span>
						</button>
					))
				)}
			</div>
		</Modal>
	);
}
