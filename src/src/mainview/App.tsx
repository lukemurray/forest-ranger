import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { onDataChanged } from "./rpc";

export default function App() {
	// Refetch all route data when the Bun process signals a change.
	useEffect(() => {
		const off = onDataChanged(() => router.invalidate());
		return () => {
			off();
		};
	}, []);
	return <RouterProvider router={router} />;
}
