import { useEffect, useState } from "react";
import { api } from "../rpc";
import { tildePath } from "../lib/format";
import { BranchCombobox } from "./BranchCombobox";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import styles from "./NewWorktreeDialog.module.css";

export function NewWorktreeDialog({
	open,
	onOpenChange,
	projectId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	onCreated: (worktreeId: string, path: string, startChat: boolean) => void;
}) {
	const [branches, setBranches] = useState<string[]>([]);
	const [name, setName] = useState("");
	const [base, setBase] = useState("");
	const [location, setLocation] = useState("");
	const [startChat, setStartChat] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setName("");
		setError(null);
		setBusy(false);
		setStartChat(false);
		api.projectBranches({ projectId }).then((r) => {
			setBranches(r.branches);
			setBase(r.base ?? "");
			setLocation(tildePath(r.worktreeDir));
		});
	}, [open, projectId]);

	async function create() {
		setBusy(true);
		setError(null);
		const res = await api.createWorktree({
			projectId,
			name,
			base: base || null,
			location: location.trim() || null,
		});
		setBusy(false);
		if (!res.ok || !res.worktreeId) {
			setError(res.error ?? "Failed to create worktree");
			return;
		}
		onCreated(res.worktreeId, res.path ?? "", startChat);
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>New worktree</ModalTitle>

			<div className={styles.fields}>
				<TextField
					label="Branch name (optional)"
					mono
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && !busy && create()}
					placeholder="auto-generated if blank"
					spellCheck={false}
					autoFocus
				/>

				<div className={styles.field}>
					<span className={styles.label}>Base branch</span>
					<BranchCombobox
						value={base}
						branches={branches}
						onSelect={setBase}
						placeholder="current HEAD"
						block
					/>
				</div>

				<TextField
					label="Location"
					mono
					value={location}
					onChange={(e) => setLocation(e.target.value)}
					spellCheck={false}
					placeholder="~/path/to/worktrees"
				/>

				<label className={styles.check}>
					<input
						type="checkbox"
						checked={startChat}
						onChange={(e) => setStartChat(e.target.checked)}
					/>
					Start a Claude chat in the new worktree
				</label>
			</div>

			{error && <p className={styles.error}>{error}</p>}

			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" onClick={create} disabled={busy}>
					{busy ? "Creating…" : "Create worktree"}
				</Button>
			</div>
		</Modal>
	);
}
