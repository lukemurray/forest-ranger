import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { onDataChanged } from "./rpc";
import { resolveDefaults } from "./lib/openTargets";
import { Toaster } from "./components/Toaster";

export default function App() {
	// Refetch all route data when the Bun process signals a change.
	useEffect(() => {
		const off = onDataChanged(() => router.invalidate());
		return () => {
			off();
		};
	}, []);

	// Warm app detection and settle default editor/terminal choices on startup.
	useEffect(() => {
		resolveDefaults();
	}, []);

	return (
		<>
			<RouterProvider router={router} />
			<Toaster />
		</>
	);
}
