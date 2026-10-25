import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { onNavigate } from "../rpc";
import { saveAllFiles } from "../lib/fileSavers";
import { Sidebar } from "../components/Sidebar";
import { CommandPalette } from "../components/CommandPalette";
import { FilePalette } from "../components/FilePalette";
import { togglePanel, showPanelView } from "../lib/panelStore";
import { TitlebarSlotContext } from "../lib/titlebarSlot";
import { rootRoute, router } from "../router";
import styles from "./RootLayout.module.css";

const SIDEBAR_WIDTH_KEY = "forest-ranger:sidebar-width";

export function RootLayout() {
	const projects = rootRoute.useLoaderData();
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	const navigate = useNavigate();

	// Attention notifications ask us to jump to a worktree when clicked.
	useEffect(() => {
		const off = onNavigate(({ projectId, worktreeId }) => {
			navigate({
				to: "/project/$projectId/worktree/$worktreeId",
				params: { projectId, worktreeId },
			});
		});
		return () => void off();
	}, [navigate]);

	// Panel shortcuts: ⌘B toggles the review panel, ⌘1 shows the changes/review
	// view, ⌘2 the files view. (⌘P and ⌘T/⌘K are owned by the palettes.)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.altKey && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void saveAllFiles(); // ⌥⌘S — save every open editor
				return;
			}
			// History nav, VS Code style. Back: ⌃-. Forward: ⌃⇧- (VS Code's own, same
			// physical key as minus) OR ⌃+ / ⌃= (the intuitive "plus" key). These don't
			// conflict with Monaco or macOS text editing, so they work everywhere,
			// including inside a code editor. `code` is layout-stable (Shift turning "-"
			// into "_", or "=" into "+", doesn't change it).
			if (e.ctrlKey && !e.metaKey && !e.altKey) {
				if (e.code === "Minus" && !e.shiftKey) {
					e.preventDefault();
					router.history.back();
					return;
				}
				if (e.code === "Equal" || (e.code === "Minus" && e.shiftKey)) {
					e.preventDefault();
					router.history.forward();
					return;
				}
			}
			if (e.altKey) return;
			// ⌘[ / ⌘] navigate history back/forward (macOS-standard, and unlike
			// ⌘⌥← / ⌘⌥→ they aren't swallowed by Chromium's tab-switch accelerator).
			// Let Monaco keep them for outdent/indent when a code editor has focus.
			if (e.key === "[" || e.key === "]") {
				if ((e.target as HTMLElement)?.closest?.(".monaco-editor")) return;
				e.preventDefault();
				if (e.key === "[") router.history.back();
				else router.history.forward();
				return;
			}
			if (e.key.toLowerCase() === "b") {
				e.preventDefault();
				togglePanel();
			} else if (e.key === "1") {
				e.preventDefault();
				showPanelView("review");
			} else if (e.key === "2") {
				e.preventDefault();
				showPanelView("files");
			} else if (e.shiftKey && e.key.toLowerCase() === "f") {
				e.preventDefault();
				showPanelView("search");
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
