import { useEffect, useState } from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar";
import { CommandPalette } from "../components/CommandPalette";
import { FilePalette } from "../components/FilePalette";
import { togglePanel, showPanelView } from "../lib/panelStore";
import { TitlebarSlotContext } from "../lib/titlebarSlot";
import { rootRoute } from "../router";
import styles from "./RootLayout.module.css";

const SIDEBAR_WIDTH_KEY = "forest-ranger:sidebar-width";

export function RootLayout() {
	const projects = rootRoute.useLoaderData();
	const [slot, setSlot] = useState<HTMLElement | null>(null);

	// Panel shortcuts: ⌘B toggles the review panel, ⌘1 shows the changes/review
	// view, ⌘2 the files view. (⌘P and ⌘T/⌘K are owned by the palettes.)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
			if (e.key.toLowerCase() === "b") {
				e.preventDefault();
				togglePanel();
			} else if (e.key === "1") {
				e.preventDefault();
				showPanelView("review");
			} else if (e.key === "2") {
				e.preventDefault();
				showPanelView("files");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const [sidebarWidth, setSidebarWidth] = useState(
		() => Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 264,
	);

	function onResizeDown(e: React.MouseEvent) {
		const startX = e.clientX;
		const startW = sidebarWidth;
		const move = (ev: MouseEvent) => {
			const next = Math.max(200, Math.min(520, startW + (ev.clientX - startX)));
			setSidebarWidth(next);
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	}

	return (
		<div
			className={styles.shell}
			style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` } as React.CSSProperties}
		>
			<CommandPalette />
			<FilePalette />
			<Sidebar projects={projects} />
			<div className={styles.resizer} style={{ left: sidebarWidth }} onMouseDown={onResizeDown} />
			<div className={styles.workarea}>
				<div ref={setSlot} className={styles.titlebarSlot} />
				<TitlebarSlotContext.Provider value={slot}>
					<main className={styles.main}>
						<Outlet />
					</main>
				</TitlebarSlotContext.Provider>
			</div>
		</div>
	);
}
