import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useTitlebarSlot } from "../lib/titlebarSlot";
import { ArrowLeftIcon, ArrowRightIcon } from "./icons";
import styles from "./Titlebar.module.css";

/**
 * Browser-style back/forward through the router history. ⌘[ / ⌘] fire the same
 * actions (wired globally in RootLayout). Back disables at the start of history;
 * the history API exposes no `canGoForward`, so forward stays enabled and no-ops
 * at the end.
 */
function HistoryNav() {
	const router = useRouter();
	// Re-render on every navigation so canGoBack() re-evaluates.
	useRouterState({ select: (s) => s.location.href });
	const canBack = router.history.canGoBack();
	return (
		<div className={`${styles.nav} app-region-no-drag`}>
			<button
				className={styles.navBtn}
				onClick={() => router.history.back()}
				disabled={!canBack}
				data-tip="Back  ⌘[  ·  ⌃-"
				aria-label="Back"
			>
				<ArrowLeftIcon size={16} />
			</button>
			<button
				className={styles.navBtn}
				onClick={() => router.history.forward()}
				data-tip="Forward  ⌘]  ·  ⌃+"
				aria-label="Forward"
			>
				<ArrowRightIcon size={16} />
			</button>
		</div>
	);
}

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
			<HistoryNav />
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
