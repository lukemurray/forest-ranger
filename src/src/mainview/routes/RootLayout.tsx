import { useState } from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "../components/Sidebar";
import { TitlebarSlotContext } from "../lib/titlebarSlot";
import { rootRoute } from "../router";
import styles from "./RootLayout.module.css";

export function RootLayout() {
	const projects = rootRoute.useLoaderData();
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	return (
		<div className={styles.shell}>
			<Sidebar projects={projects} />
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
