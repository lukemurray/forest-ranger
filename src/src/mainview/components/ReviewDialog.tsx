import { useEffect, useState } from "react";
import { api } from "../rpc";
import { BranchCombobox } from "./BranchCombobox";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import styles from "./NewWorktreeDialog.module.css";

/** The default review instruction, keyed to the chosen branch + base. */
export function reviewPrompt(branch: string, base: string | null): string {
	const b = base ?? "the main branch";
	return `Review the branch \`${branch}\` against \`${b}\`. This worktree is a detached checkout at \`${branch}\` for review.

Start by seeing what changed:
- \`git log ${b}..HEAD --oneline\` for the commits
- \`git diff ${b}...HEAD\` for the full diff

Then give me a review:
- Summarize what the branch does and why.
- Flag bugs, edge cases, security issues, and consistency/style problems — cite specific files and lines.
- Call out anything risky, unclear, or worth discussing.

Don't change any code — this is a read-only review.`;
}

/**
 * Pick a branch to review, with an editable prompt (defaults to the auto one).
 * Creates a throwaway detached worktree at that branch and opens a chat with the
 * given prompt (handled by `onSubmit`).
 */
export function ReviewDialog({
	open,
	onOpenChange,
	projectId,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	onSubmit: (branch: string, base: string | null, prompt: string) => Promise<void>;
}) {
	const [branches, setBranches] = useState<string[]>([]);
	const [base, setBase] = useState<string | null>(null);
	const [branch, setBranch] = useState("");
	const [custom, setCustom] = useState(false);
	const [prompt, setPrompt] = useState("");
	// Once the user edits the prompt, stop re-syncing it to the branch selection.
	const [edited, setEdited] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		setBranch("");
		setCustom(false);
		setPrompt("");
		setEdited(false);
		setBusy(false);
		api.projectBranches({ projectId }).then((r) => {
			setBranches(r.branches.filter((b) => b !== r.base));
			setBase(r.base);
		});
	}, [open, projectId]);

	// Keep the (hidden) prompt in sync with the picked branch until the user edits it.
	useEffect(() => {
		if (!edited) setPrompt(branch ? reviewPrompt(branch, base) : "");
	}, [branch, base, edited]);

	async function start() {
		if (!branch || busy) return;
		setBusy(true);
		const finalPrompt = custom && prompt.trim() ? prompt.trim() : reviewPrompt(branch, base);
		await onSubmit(branch, base, finalPrompt);
		setBusy(false);
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={520}>
			<ModalTitle className={styles.title}>Review a branch</ModalTitle>

			<div className={styles.fields}>
				<div className={styles.field}>
					<span className={styles.label}>Branch to review</span>
					<BranchCombobox
						value={branch}
						branches={branches}
						onSelect={setBranch}
						placeholder="pick a branch"
						block
					/>
				</div>

				<label className={styles.check}>
					<input
						type="checkbox"
						checked={custom}
						onChange={(e) => setCustom(e.target.checked)}
					/>
					Customize the review prompt
				</label>

				{custom && (
					<div className={styles.field}>
						<textarea
							className={styles.promptArea}
							value={prompt}
							spellCheck={false}
							rows={9}
							placeholder="Pick a branch to fill the default prompt, or write your own."
							onChange={(e) => {
								setPrompt(e.target.value);
								setEdited(true);
							}}
						/>
					</div>
				)}

				<p className={styles.hint}>
					Opens a detached worktree at this branch and starts a chat to review it
					{base ? ` against ${base}` : ""}.
				</p>
			</div>

			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" onClick={start} disabled={busy || !branch}>
					{busy ? "Starting…" : "Start review"}
				</Button>
			</div>
		</Modal>
	);
}
