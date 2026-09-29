import { useEffect, useState } from "react";
import { api } from "../rpc";
import { DEFAULT_REVIEW_PROMPT, getChatConfig, setReviewPrompt, useChatConfig } from "../lib/chatConfig";
import { BranchCombobox } from "./BranchCombobox";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import styles from "./NewWorktreeDialog.module.css";

/** The review instruction for the chosen branch + base, from the project's
 *  template (project Settings tab) or the built-in default. */
export function reviewPrompt(projectId: string, branch: string, base: string | null): string {
	const template = getChatConfig().reviewPromptByProject?.[projectId]?.trim() || DEFAULT_REVIEW_PROMPT;
	return template.replaceAll("{branch}", branch).replaceAll("{base}", base ?? "the main branch");
}

/**
 * Pick a branch to review, with an editable prompt (defaults to the Settings
 * template). Checks the branch out in a worktree (reusing one that already has it)
 * and opens a chat with the given prompt (handled by `onSubmit`).
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
		if (!edited) setPrompt(branch ? reviewPrompt(projectId, branch, base) : "");
	}, [branch, base, edited]);

	async function start() {
		if (!branch || busy) return;
		setBusy(true);
		const finalPrompt = custom && prompt.trim() ? prompt.trim() : reviewPrompt(projectId, branch, base);
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

/** Project Settings field: this project's review prompt, as an editable template. */
export function ReviewPromptField({ projectId }: { projectId: string }) {
	const saved = useChatConfig().reviewPromptByProject?.[projectId];
	const custom = saved !== undefined && saved !== DEFAULT_REVIEW_PROMPT;
	return (
		<div className={styles.field}>
			<textarea
				className={styles.promptArea}
				value={saved ?? DEFAULT_REVIEW_PROMPT}
				onChange={(e) => setReviewPrompt(projectId, e.target.value)}
				rows={14}
				spellCheck={false}
				aria-label="Review prompt"
			/>
			<div className={styles.promptFooter}>
				<p className={styles.hint}>
					<code>{"{branch}"}</code> and <code>{"{base}"}</code> are filled in when a review starts.
				</p>
				{custom && (
					<Button variant="subtle" onClick={() => setReviewPrompt(projectId, undefined)}>
						Reset to default
					</Button>
				)}
			</div>
		</div>
	);
}
