import { useRef, useState } from "react";
import {
	closeSession,
	setActiveSession,
	setDock,
	setDockOpen,
	useTerminals,
} from "../lib/terminalStore";
import { TerminalPane } from "./TerminalPane";
import { ChevronIcon, TerminalIcon } from "./icons";
import styles from "./TerminalDock.module.css";

export function TerminalDock() {
	const { sessions, activeId, dock, open } = useTerminals();
	const [size, setSize] = useState(() => {
		const saved = Number(localStorage.getItem("forest-ranger:dock-size"));
		return saved || (dock === "bottom" ? 280 : 460);
	});
	const drag = useRef<{ start: number; size: number } | null>(null);

	// No sessions → nothing to show.
	if (sessions.length === 0) return null;

	// Hidden but sessions still running → collapsed strip so it can be reopened.
	if (!open) {
		return (
			<button
				className={`${styles.collapsed} ${dock === "side" ? styles.collapsedSide : styles.collapsedBottom}`}
				onClick={() => setDockOpen(true)}
				title="Show terminal"
			>
				<TerminalIcon size={14} />
				<span>Terminal{sessions.length > 1 ? ` (${sessions.length})` : ""}</span>
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
					{sessions.map((s) => (
						<button
							key={s.id}
							className={styles.tab}
							data-active={s.id === activeId || undefined}
							onClick={() => setActiveSession(s.id)}
							title={s.title}
						>
							<span className={styles.tabLabel}>{s.title}</span>
							<span
								className={styles.tabClose}
								onClick={(e) => {
									e.stopPropagation();
									closeSession(s.id);
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
				{sessions.map((s) => (
					<div
						key={s.id}
						className={styles.pane}
						style={{ display: s.id === activeId ? "block" : "none" }}
					>
						<TerminalPane
							sessionId={s.id}
							worktreeId={s.worktreeId}
							commandId={s.commandId}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
