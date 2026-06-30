import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTitlebarSlot } from "../lib/titlebarSlot";
import styles from "./Titlebar.module.css";

/**
 * The draggable top strip of the main panel, aligned with the native titlebar.
 * Hosts the current view's title (left) and actions (right) — like an app
 * window's title area. Title content is part of the drag region; `actions` are
 * marked no-drag so they stay clickable.
 */
export function Titlebar({
	children,
	actions,
	title,
}: {
	children: ReactNode;
	actions?: ReactNode;
	title?: string;
}) {
	const slot = useTitlebarSlot();
	const bar = (
		<div className={`${styles.bar} app-region-drag`}>
			<div className={styles.left} title={title}>
				{children}
			</div>
			{actions && (
				<div className={`${styles.actions} app-region-no-drag`}>
					{actions}
				</div>
			)}
		</div>
	);
	// Hoist into the layout's full-width titlebar row so it spans the top above
	// the side dock; fall back to inline if the slot isn't mounted yet.
	return slot ? createPortal(bar, slot) : bar;
}
