import {
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { api } from "./rpc";
import { ErrorView } from "./components/ErrorView";
import { RootLayout } from "./routes/RootLayout";
import { RecentView } from "./routes/RecentView";
import { ProjectView } from "./routes/ProjectView";
import { WorktreeView } from "./routes/WorktreeView";

export const rootRoute = createRootRoute({
	component: RootLayout,
	loader: () => api.listProjects({}),
});

export const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	loader: () => api.recentWorktrees({ limit: 50 }),
	component: RecentView,
});

export const projectRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/project/$projectId",
	loader: ({ params }) => api.listWorktrees({ projectId: params.projectId }),
	component: ProjectView,
});

export const worktreeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/project/$projectId/worktree/$worktreeId",
	loader: ({ params }) => api.worktreeDetail({ id: params.worktreeId }),
	component: WorktreeView,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	projectRoute,
	worktreeRoute,
]);

export const router = createRouter({
	routeTree,
	defaultPreload: false,
	defaultPendingMs: 0,
	defaultErrorComponent: ErrorView,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
