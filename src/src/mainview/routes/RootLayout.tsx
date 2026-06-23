import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar";
import { rootRoute } from "../router";
import styles from "./RootLayout.module.css";

export function RootLayout() {
	const projects = rootRoute.useLoaderData();
	return (
		<div className={styles.shell}>
			<Sidebar projects={projects} />
			<main className={styles.main}>
				<div className={`${styles.titlebar} electrobun-webkit-app-region-drag`} />
				<div className={styles.scroll}>
					<Outlet />
				</div>
			</main>
		</div>
	);
}
