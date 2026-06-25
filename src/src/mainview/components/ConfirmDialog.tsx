import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import styles from "./ConfirmDialog.module.css";

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
	danger,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
	danger?: boolean;
}) {
	return (
		<Modal open={open} onOpenChange={onOpenChange} width={360}>
			<ModalTitle className={styles.title}>{title}</ModalTitle>
			<p className={styles.description}>{description}</p>
			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button
					variant={danger ? "danger" : "primary"}
					onClick={() => {
						onConfirm();
						onOpenChange(false);
					}}
				>
					{confirmLabel}
				</Button>
			</div>
		</Modal>
	);
}
