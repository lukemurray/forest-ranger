import { useEffect, useState } from "react";
import { api } from "../rpc";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import styles from "./CommandDialog.module.css";

/**
 * Set a worktree's display name (stored in the app, not git). Blank reverts to
 * the branch label. Unlike RenameBranchDialog this never touches the git branch,
 * so it works for detached worktrees (e.g. review checkouts) too.
 */
export function RenameWorktreeDialog({
	open,
	onOpenChange,
	worktreeId,
	current,
	onRenamed,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	worktreeId: string;
	/** Current label to prefill (custom name, or the branch). */
	current: string;
	onRenamed: () => void;
}) {
	const [name, setName] = useState(current);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setName(current);
			setBusy(false);
		}
	}, [open, current]);

	async function save() {
		setBusy(true);
		await api.renameWorktree({ id: worktreeId, name: name.trim() || null });
		setBusy(false);
		onRenamed();
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>Rename worktree</ModalTitle>
			<div className={styles.fields}>
				<TextField
					label="Display name"
					value={name}
					autoFocus
					spellCheck={false}
					placeholder="leave blank to use the branch name"
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && save()}
				/>
			</div>
			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" disabled={busy} onClick={save}>
					{busy ? "Saving…" : "Save"}
				</Button>
			</div>
		</Modal>
	);
}
