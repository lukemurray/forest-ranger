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
	unpushed: number;
	hasUpstream: boolean;
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

	// Force is only about uncommitted changes (git's actual constraint). Removing a
	// worktree keeps the branch + its commits, so committed work is never lost here.
	const dirty = !!info && info.uncommitted > 0;
	const blocked = !info || info.isPrimary || (dirty && !force);
	// Deleting the branch is the only thing that loses commits — and only unpushed ones.
	const branchRisk = !!info && (info.unpushed > 0 || !info.hasUpstream);

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
							{info.hasUpstream ? (
								info.unpushed > 0 ? (
									<li className={styles.bad}>
										{info.unpushed} commit{info.unpushed === 1 ? "" : "s"} not pushed to origin
									</li>
								) : (
									<li className={styles.ok}>Pushed to origin</li>
								)
							) : (
								<li className={styles.bad}>Not pushed to any remote</li>
							)}
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
									Force remove — discards uncommitted changes
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
							{deleteBranch && branchRisk && (
								<p className={styles.warn}>
									{info.hasUpstream
										? `Discards ${info.unpushed} commit${info.unpushed === 1 ? "" : "s"} not on origin.`
										: "This branch isn't on any remote — deleting it discards its commits."}
								</p>
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
