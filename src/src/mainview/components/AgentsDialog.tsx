import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { AgentsManager } from "./AgentsManager";
import styles from "./AgentsDialog.module.css";

export function AgentsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Modal open={open} onOpenChange={onOpenChange} width={460}>
			<ModalTitle className={styles.title}>Chat agents</ModalTitle>
			<p className={styles.subtitle}>
				Model + permission-mode presets for the in-app chat. To run an agent's CLI
				directly, open a terminal in the worktree.
			</p>

			<AgentsManager />

			<div className={styles.actions}>
				<ModalClose className={styles.done}>Done</ModalClose>
			</div>
		</Modal>
	);
}
