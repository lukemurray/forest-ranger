import {
	createHashHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { api } from "./rpc";
import { ErrorView } from "./components/ErrorView";
import { RootLayout } from "./routes/RootLayout";
import { HomeView } from "./routes/HomeView";
import { ProjectView } from "./routes/ProjectView";
import { WorktreePending, WorktreeView } from "./routes/WorktreeView";

export const rootRoute = createRootRoute({
	component: RootLayout,
	loader: () => api.listProjects({}),
});

export const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	// No loader: a cold worktree scan (git status per worktree) takes seconds right
	// after launch, and a route loader blocks the whole first paint. Home renders its
	// inbox at once and fetches the worktree list itself.
	component: HomeView,
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
	// Feedback for a slow first open (a revisit shows its cached data at once while
	// it refreshes). Not for fast loads: only after 150ms, and then held briefly so
	// it doesn't flicker.
	pendingComponent: WorktreePending,
	pendingMs: 150,
	pendingMinMs: 200,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
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
