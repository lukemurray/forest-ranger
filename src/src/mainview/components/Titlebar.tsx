import type { ReactNode } from "react";
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
	return (
		<div className={`${styles.bar} electrobun-webkit-app-region-drag`}>
			<div className={styles.left} title={title}>
				{children}
			</div>
			{actions && (
				<div className={`${styles.actions} electrobun-webkit-app-region-no-drag`}>
					{actions}
				</div>
			)}
		</div>
	);
}
