import type { ReactNode } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import styles from "./Modal.module.css";

/**
 * Shared modal chrome built on Base UI Dialog — backdrop + centered popup.
 * Dialogs render their own title/body/footer as `children`; pass `width` (px)
 * and `padded` for the common case, or `className` for custom layouts.
 */
export function Modal({
	open,
	onOpenChange,
	children,
	width = 420,
	padded = true,
	className,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	width?: number;
	padded?: boolean;
	className?: string;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={styles.backdrop} />
				<Dialog.Popup
					className={`${styles.popup} ${padded ? styles.padded : ""} ${className ?? ""}`}
					style={{ width }}
				>
					{children}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

// Re-exported so callers don't import Base UI directly for these.
export const ModalTitle = Dialog.Title;
export const ModalClose = Dialog.Close;
export const ModalDescription = Dialog.Description;
