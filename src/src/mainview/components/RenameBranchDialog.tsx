import { useEffect, useState } from "react";
import { api } from "../rpc";
import { notify } from "../lib/toast";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import styles from "./CommandDialog.module.css";

/** Rename the worktree's local branch (git branch -m). The directory is untouched. */
export function RenameBranchDialog({
	open,
	onOpenChange,
	projectId,
	branch,
	onRenamed,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	branch: string;
	onRenamed: () => void;
}) {
	const [name, setName] = useState(branch);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setName(branch);
			setBusy(false);
		}
	}, [open, branch]);

	const to = name.trim();
	const valid = to !== "" && to !== branch;

	async function save() {
		if (!valid) return;
		setBusy(true);
		const res = await api.renameBranch({ projectId, from: branch, to });
		setBusy(false);
		if (res.ok) {
			onRenamed();
			onOpenChange(false);
		} else {
			notify(`Couldn't rename: ${res.error ?? "failed"}`, "error");
		}
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>Rename branch</ModalTitle>
			<div className={styles.fields}>
				<TextField
					label="Branch name"
					mono
					value={name}
					autoFocus
					spellCheck={false}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && save()}
				/>
			</div>
			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" disabled={!valid || busy} onClick={save}>
					{busy ? "Renaming…" : "Rename"}
				</Button>
			</div>
		</Modal>
	);
}
