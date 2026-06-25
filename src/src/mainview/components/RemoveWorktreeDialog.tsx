import { useEffect, useState } from "react";
import { api } from "../rpc";
import { tildePath } from "../lib/format";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import styles from "./RemoveWorktreeDialog.module.css";

type Info = {
	branch: string | null;
	path: string;
	isPrimary: boolean;
	uncommitted: number;
	unmerged: number;
	base: string | null;
};

export function RemoveWorktreeDialog({
	open,
	onOpenChange,
	worktreeId,
	onRemoved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	worktreeId: string;
	onRemoved: () => void;
}) {
	const [info, setInfo] = useState<Info | null>(null);
	const [force, setForce] = useState(false);
	const [deleteBranch, setDeleteBranch] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setInfo(null);
		setForce(false);
		setDeleteBranch(false);
		setError(null);
		setBusy(false);
		api.worktreeRemovalInfo({ id: worktreeId }).then(setInfo);
	}, [open, worktreeId]);

	const dirty = !!info && (info.uncommitted > 0 || info.unmerged > 0);
	const blocked = !info || info.isPrimary || (dirty && !force);

	async function remove() {
		setBusy(true);
		setError(null);
		const res = await api.removeWorktree({
			id: worktreeId,
			force: dirty && force,
			deleteBranch,
		});
		setBusy(false);
		if (!res.ok) {
			setError(res.error ?? "Failed to remove worktree");
			return;
		}
		onRemoved();
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>Remove worktree</ModalTitle>

			{info && (
				<>
					<div className={styles.target}>
						<span className={styles.branch}>{info.branch ?? "detached"}</span>
						<span className={styles.path}>{tildePath(info.path)}</span>
					</div>

					{info.isPrimary ? (
						<p className={styles.warn}>
							This is the primary worktree and can't be removed.
						</p>
					) : (
						<ul className={styles.status}>
							{info.uncommitted > 0 ? (
								<li className={styles.bad}>
									{info.uncommitted} uncommitted change
									{info.uncommitted === 1 ? "" : "s"}
								</li>
							) : (
								<li className={styles.ok}>No uncommitted changes</li>
							)}
							{info.base &&
								(info.unmerged > 0 ? (
									<li className={styles.bad}>
										{info.unmerged} commit{info.unmerged === 1 ? "" : "s"} not in{" "}
										{info.base}
									</li>
								) : (
									<li className={styles.ok}>Merged into {info.base}</li>
								))}
						</ul>
					)}

					{!info.isPrimary && (
						<div className={styles.options}>
							{dirty && (
								<label className={styles.check}>
									<input
										type="checkbox"
										checked={force}
										onChange={(e) => setForce(e.target.checked)}
									/>
									Force remove — discards the changes above
								</label>
							)}
							{info.branch && (
								<label className={styles.check}>
									<input
										type="checkbox"
										checked={deleteBranch}
										onChange={(e) => setDeleteBranch(e.target.checked)}
									/>
									Also delete branch <code>{info.branch}</code>
								</label>
							)}
						</div>
					)}
				</>
			)}

			{error && <p className={styles.error}>{error}</p>}

			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button
					variant="danger"
					onClick={remove}
					disabled={blocked || busy}
				>
					{busy ? "Removing…" : "Remove worktree"}
				</Button>
			</div>
		</Modal>
	);
}
