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
			<ModalTitle className={styles.title}>Agents</ModalTitle>
			<p className={styles.subtitle}>
				CLI agents you can launch in a worktree's terminal.
			</p>

			<AgentsManager />

			<div className={styles.actions}>
				<ModalClose className={styles.done}>Done</ModalClose>
			</div>
		</Modal>
	);
}
