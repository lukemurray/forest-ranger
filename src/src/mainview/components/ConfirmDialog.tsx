import { AlertDialog } from "@base-ui-components/react/alert-dialog";
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
		<AlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Backdrop className={styles.backdrop} />
				<AlertDialog.Popup className={styles.popup}>
					<AlertDialog.Title className={styles.title}>{title}</AlertDialog.Title>
					<AlertDialog.Description className={styles.description}>
						{description}
					</AlertDialog.Description>
					<div className={styles.actions}>
						<AlertDialog.Close className={styles.cancel}>Cancel</AlertDialog.Close>
						<button
							className={danger ? styles.danger : styles.confirm}
							onClick={() => {
								onConfirm();
								onOpenChange(false);
							}}
						>
							{confirmLabel}
						</button>
					</div>
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}
