import { useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import {
	closeSession,
	setActiveSession,
	setDock,
	setDockOpen,
	useTerminals,
} from "../lib/terminalStore";
import { bus } from "../rpc";
import { TerminalPane } from "./TerminalPane";
import { ChevronIcon, TerminalIcon } from "./icons";
import styles from "./TerminalDock.module.css";

/** Close a tab: kill the PTY (explicit) and drop the session. */
function endSession(id: string) {
	bus.termKill({ sessionId: id });
	closeSession(id);
}

export function TerminalDock() {
	const { sessions, activeId, dock, open } = useTerminals();
	const params = useParams({ strict: false });
	const worktreeId = params.worktreeId;
	const [size, setSize] = useState(() => {
		const saved = Number(localStorage.getItem("forest-ranger:dock-size"));
		return saved || (dock === "bottom" ? 280 : 460);
	});
	const drag = useRef<{ start: number; size: number } | null>(null);

	// A terminal belongs to a worktree: only show sessions for the one in view.
	const visible = sessions.filter((s) => s.worktreeId === worktreeId);
	const activeVisibleId = visible.some((s) => s.id === activeId)
		? activeId
		: (visible[0]?.id ?? null);

	if (visible.length === 0) return null;

	// Hidden but sessions still running → collapsed strip so it can be reopened.
	if (!open) {
		return (
			<button
				className={`${styles.collapsed} ${dock === "side" ? styles.collapsedSide : styles.collapsedBottom}`}
				onClick={() => setDockOpen(true)}
				title="Show terminal"
			>
				<TerminalIcon size={14} />
				<span>Terminal{visible.length > 1 ? ` (${visible.length})` : ""}</span>
			</button>
		);
	}

	function onResizeDown(e: React.MouseEvent) {
		drag.current = { start: dock === "bottom" ? e.clientY : e.clientX, size };
		const move = (ev: MouseEvent) => {
			if (!drag.current) return;
			const delta =
				dock === "bottom"
					? drag.current.start - ev.clientY // drag up = taller
					: drag.current.start - ev.clientX; // drag left = wider
			const next = Math.max(140, Math.min(900, drag.current.size + delta));
			setSize(next);
			localStorage.setItem("forest-ranger:dock-size", String(next));
		};
		const up = () => {
			drag.current = null;
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	return (
		<div
			className={`${styles.dock} ${dock === "side" ? styles.side : styles.bottom}`}
			style={dock === "bottom" ? { height: size } : { width: size }}
		>
			<div className={styles.resizer} onMouseDown={onResizeDown} />
			<div className={styles.header}>
				<div className={styles.tabs}>
					{visible.map((s) => (
						<button
							key={s.id}
							className={styles.tab}
							data-active={s.id === activeVisibleId || undefined}
							onClick={() => setActiveSession(s.id)}
							title={s.title}
						>
							<span className={styles.tabLabel}>{s.title}</span>
							<span
								className={styles.tabClose}
								onClick={(e) => {
									e.stopPropagation();
									endSession(s.id);
								}}
							>
								×
							</span>
						</button>
					))}
				</div>
				<div className={styles.controls}>
					<button
						className={styles.control}
						onClick={() => setDock(dock === "bottom" ? "side" : "bottom")}
						title={dock === "bottom" ? "Move to side" : "Move to bottom"}
					>
						{dock === "bottom" ? "⇥" : "⤓"}
					</button>
					<button
						className={styles.control}
						onClick={() => setDockOpen(false)}
						title="Hide terminal"
					>
						<ChevronIcon size={14} />
					</button>
				</div>
			</div>
			<div className={styles.body}>
				{visible.map((s) => (
					<div
						key={s.id}
						className={styles.pane}
						style={{ display: s.id === activeVisibleId ? "block" : "none" }}
					>
						<TerminalPane
							sessionId={s.id}
							worktreeId={s.worktreeId}
							commandId={s.commandId}
							command={s.command}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
