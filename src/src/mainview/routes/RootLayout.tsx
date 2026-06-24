import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar";
import { TerminalDock } from "../components/TerminalDock";
import { useTerminals } from "../lib/terminalStore";
import { rootRoute } from "../router";
import styles from "./RootLayout.module.css";

export function RootLayout() {
	const projects = rootRoute.useLoaderData();
	const { dock } = useTerminals();
	return (
		<div className={styles.shell}>
			<Sidebar projects={projects} />
			<div className={styles.workarea} data-dock={dock}>
				<main className={styles.main}>
					<Outlet />
				</main>
				<TerminalDock />
			</div>
		</div>
	);
}
