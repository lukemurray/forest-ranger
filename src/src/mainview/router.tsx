import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { api } from "./rpc";
import { ErrorView } from "./components/ErrorView";
import { RootLayout } from "./routes/RootLayout";
import { RecentView } from "./routes/RecentView";
import { ActivityView } from "./routes/ActivityView";
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

export const activityRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/activity",
	component: ActivityView,
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
	validateSearch: (s: Record<string, unknown>): { base?: string } => ({
		base: typeof s.base === "string" ? s.base : undefined,
	}),
	loaderDeps: ({ search }) => ({ base: search.base ?? null }),
	loader: ({ params, deps }) =>
		api.worktreeDetail({ id: params.worktreeId, base: deps.base }),
	component: WorktreeView,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	activityRoute,
	projectRoute,
	worktreeRoute,
]);

export const router = createRouter({
	routeTree,
	// Hash history keeps routing independent of the URL path, which under a
	// packaged build is the on-disk `file://…/index.html` path (no route matches
	// it → "Not Found" on launch). Works identically on the dev server.
	history: createHashHistory(),
	defaultPreload: false,
	defaultPendingMs: 0,
	defaultErrorComponent: ErrorView,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
